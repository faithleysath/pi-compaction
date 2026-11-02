/**
 * pi-compaction — 用「过滤 + 截断」代替 pi 的 LLM 摘要。
 *
 * 触发时机完全交给 pi（自动阈值 / 溢出恢复 / 手动 /compact），只替换压缩过程：
 *   用户消息原文保留 / 助手正文原文保留 / thinking 丢弃 / 图片只留 [image png] 占位
 *   工具参数截断到 500 字（取头部）；工具结果 500 字（头 350 + 尾 150，exit code / 报错在末尾）
 *   最近 20 条消息原样保留（真实消息，不是文本）
 *   编号在标题行里：[user#1] / [assistant#2] / * read#2 / →#3，可用 recall 取原文
 *
 * 铁律：永远不 return undefined / 不抛错给 pi —— 那两条路径都会落到 pi 的默认 LLM 摘要。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { convertToLlm } from "@earendil-works/pi-coding-agent";

/** 尾部原样保留的消息条数。实测 20 条 ≈ 6.3k token（1M 窗口的 0.6%），够覆盖一到两个完整工具回合 */
const KEEP_MSGS = 20;
/**
 * 工具参数 / 结果的截断长度。实测本机 toolResult 的 p50 = 411、p90 = 6333，
 * 500 刚好在 p50 之上 —— 一半以上的结果原样进摘要，长的才截。
 */
const TOOL_CHARS = 500;

const HEAD = Math.round(TOOL_CHARS * 0.7); // 350
const TAIL = TOOL_CHARS - HEAD; // 150

/** 工具参数：只取头部（JSON 的关键字段在前） */
const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n)}…(+${s.length - n})`);

/** 工具结果：头 70% + 尾 30%（bash 的 exit code、报错、栈底都在末尾） */
const clipTail = (s: string) => {
	if (s.length <= TOOL_CHARS) return s;
	const cut = s.length - TOOL_CHARS;
	// 只超一点点：截头就够，不值得为几十个字插两个标记
	if (cut < TAIL) return `${s.slice(0, TOOL_CHARS)}…(+${cut})`;
	return `${s.slice(0, HEAD)}…(+${cut})…${s.slice(-TAIL)}`;
};

/**
 * 转义正文。正文是任意文本（README / 日志 / 用户粘贴），它自己也能写出
 * `[user#1]`、`* bash#2`、`→#3`、`…(+N)`、`</summary>` —— 不转义就能伪装成我们的条目。
 * 只在真的要撞的时候加一个反斜杠，实测开销接近于零（本机整段压缩 +7 字符）。
 */
const esc = (s: string) =>
	s
		.replace(/\(#(\d+)\)/g, "(\\#$1)") // 老格式 (#N)：别让模型拿它去 recall
		.replace(/…\(\+(\d+)\)/g, "…(\\+$1)") // 假截断标记
		.replace(/<\/summary>/gi, "<\\/summary>") // 不让它提前闭合 pi 的 <summary> 包裹
		// 假结构行：[user#12] / [assistant] / * bash#3 / →#4 一律转义，免得伪装成真条目
		.replace(/^(\[user(?=[#\]])|\[assistant(?=[#\]])|\* |→(?=[ #]))/gm, "\\$1");

/**
 * 摘要开头的一行格式说明。实测（本机 24 次）：不加时模型只有 ~60% 能分清
 * 「条目」和「正文里长得像条目的字面文本」，加上后 20/24、12/12。
 * 84 字符 ≈ 21 token，比把正文全部缩进（+743 token）便宜得多。
 */
const FORMAT_NOTE =
	"格式：以 [user#N] / [assistant#N] / * 工具#N / →#N 开头的行是条目（行首无反斜杠）；其余是上一条的正文；带反斜杠的是正文字面文本。";

/** 上一轮末尾的提示语，拼接前剥掉，不然每轮累加一份 */
const TAIL_NOTE = "可用 recall 工具按 #N 取原文；图片可加 image:true 取回。";
const TAIL_RE = /\n*---\n可用 recall 工具按 #N 取原文[^\n]*\n?\s*$/;
const FORMAT_RE = new RegExp(`^${FORMAT_NOTE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n*`);

/** 图片只留一个占位符：`[image png]`。正文进不了摘要，但模型得知道这儿有张图 */
const imgTag = (mimeType: string) => `[image ${String(mimeType).replace(/^image\//, "")}]`;

const text = (c: unknown): string =>
	typeof c === "string"
		? c
		: Array.isArray(c)
			? c
					.map((p: any) => (p.type === "text" ? p.text : p.type === "image" ? imgTag(p.mimeType) : ""))
					.filter(Boolean)
					.join("\n")
			: "";

/** 全局 #N：会话文件里第 N 个 type==="message" 条目（append-only，永不复用） */
const buildRefs = (entries: any[]) => {
	const m = new Map<string, number>();
	let n = 0;
	for (const e of entries) if (e.type === "message" && e.message) m.set(e.id, n++);
	return m;
};

const isVisible = (e: any) =>
	(e.type === "message" && e.message && e.message.role !== "system") ||
	e.type === "custom_message" ||
	e.type === "branch_summary";

const render = (entries: any[], ref: Map<string, number>): string => {
	const out: string[] = [];
	for (const e of entries) {
		const r = ref.get(e.id);
		const t = r == null ? "" : `#${r}`; // 编号跟标题走，不和正文混
		const msg = e.type === "custom_message" ? { role: "custom", content: e.content } : e.message;
		if (!msg) continue;
		if (msg.role === "bashExecution") {
			// 用户敲的 ! 命令：命令原文，输出头+尾截断
			// !! 开头（excludeFromContext）的是「只要结果、不进上下文」，pi 会丢掉，我们也得丢
			if (msg.excludeFromContext) continue;
			out.push(`[user${t}] $ ${esc(msg.command)}\n${clipTail(msg.output ?? "")}`);
			continue;
		}
		for (const m of convertToLlm([msg])) {
			if (m.role === "user") out.push(`[user${t}]\n${esc(text(m.content))}`);
			else if (m.role === "toolResult") out.push(`→${t} ${clipTail(esc(text(m.content)))}`);
			else if (m.role === "assistant" && Array.isArray(m.content)) {
				// 正文和图片攒成一个块，共用同一个标题行；工具调用各自一行
				let buf: string[] = [];
				const flush = () => {
					if (buf.length) out.push(`[assistant${t}]\n${buf.join("\n")}`);
					buf = [];
				};
				for (const p of m.content as any[]) {
					if (p.type === "text") buf.push(esc(p.text));
					else if (p.type === "image") buf.push(imgTag(p.mimeType));
					else if (p.type === "toolCall") {
						flush();
						out.push(`* ${p.name}${t} ${clip(esc(JSON.stringify(p.arguments ?? {})), TOOL_CHARS)}`);
					}
					// thinking 块直接不输出
				}
				flush();
			}
		}
	}
	return out.join("\n\n");
};

export default function (pi: ExtensionAPI) {
	pi.on("session_before_compact", (event, ctx) => {
		const notify = (message: string, kind: "info" | "warning" = "info") => {
			if (ctx.hasUI) ctx.ui.notify(message, kind);
		};

		try {
			const live = event.branchEntries.filter(isVisible);

			// 从末尾数 KEEP_MSGS 条，之前的部分压成文本
			let cut = Math.max(0, live.length - KEEP_MSGS);
			// 切点不能落在 toolResult 上，否则 toolCall 和结果会被拆开
			while (cut < live.length) {
				const e = live[cut];
				if (e.type === "message" && e.message.role === "toolResult") cut++;
				else break;
			}

			if (cut === 0) {
				// 没有比最近 KEEP_MSGS 条更早的内容
				if (event.reason === "manual") {
					notify(`最近 ${KEEP_MSGS} 条消息之前的没有内容，无需压缩`);
					return { cancel: true };
				}
				// 自动阈值 / 溢出：pi 已经判定超预算，改用它的切点做算法压缩
				const piCut = live.findIndex((e: any) => e.id === event.preparation.firstKeptEntryId);
				if (piCut <= 0) return { cancel: true };
				cut = piCut;
			}

			const body = render(live.slice(0, cut), buildRefs(ctx.sessionManager.getEntries()));
			if (!body.trim()) {
				notify("待压缩的历史渲染为空，已取消", "warning");
				return { cancel: true };
			}

			// 多轮：上一轮的摘要原样前置（剥掉它自己的格式说明和尾注，避免每轮累加）
			const prev = event.preparation.previousSummary
				?.replace(FORMAT_RE, "")
				.replace(TAIL_RE, "")
				.trim();
			const summary = `${FORMAT_NOTE}\n\n${prev ? `${prev}\n\n---\n\n` : ""}${body}\n\n---\n${TAIL_NOTE}`;

			return {
				compaction: {
					summary,
					firstKeptEntryId: live[cut]?.id ?? "",
					tokensBefore: event.preparation.tokensBefore,
				},
			};
		} catch (err) {
			// 任何异常都不许 fall through 到 pi 的默认摘要
			notify(`压缩失败，已取消：${err instanceof Error ? err.message : String(err)}`, "warning");
			return { cancel: true };
		}
	});
}
