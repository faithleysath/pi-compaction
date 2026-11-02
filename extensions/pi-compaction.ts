/**
 * pi-compaction — 用「过滤 + 截断」代替 pi 的 LLM 摘要。
 *
 * 触发时机和切点都交给 pi（自动阈值 / 溢出恢复 / 手动 /compact），只替换压缩过程：
 *   切点 = event.preparation.firstKeptEntryId（pi 按 compaction.keepRecentTokens 算好的，默认 20000 tok）
 *   用户消息原文保留 / 助手正文原文保留 / thinking 丢弃 / 图片只留 [image png] 占位
 *   工具参数与结果的截断长度可配置（~/.pi/agent/pi-compaction.json 的 toolChars，默认 500）
 *   编号在标题行里：[user#1] / [assistant#2] / * read#2 / →#3，可用 recall 取原文
 *
 * 铁律：永远不 return undefined / 不抛错给 pi —— 那两条路径都会落到 pi 的默认 LLM 摘要。
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { convertToLlm, getAgentDir } from "@earendil-works/pi-coding-agent";

/** 工具参数 / 结果默认截断长度。实测本机 toolResult 的 p50 = 411、p90 = 6333 */
const DEFAULT_TOOL_CHARS = 500;

const CONFIG_PATH = join(getAgentDir(), "pi-compaction.json");

/**
 * 读配置。每次压缩读一次（压缩很少发生，开销可以忽略），这样改完配置不用重启。
 * 文件不存在或坏了就用默认值 —— 绝不因为配置问题影响压缩。
 */
const loadConfig = (): { toolChars: number } => {
	try {
		const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
		const n = raw?.toolChars;
		const valid = typeof n === "number" && Number.isSafeInteger(n) && n > 0;
		return { toolChars: valid ? n : DEFAULT_TOOL_CHARS };
	} catch {
		return { toolChars: DEFAULT_TOOL_CHARS };
	}
};

/** 第一次跑的时候生成一份默认配置，省得用户不知道有这个开关 */
const scaffoldConfig = () => {
	if (existsSync(CONFIG_PATH)) return;
	try {
		writeFileSync(CONFIG_PATH, `${JSON.stringify({ toolChars: DEFAULT_TOOL_CHARS }, null, 2)}\n`);
	} catch {
		// 只读文件系统之类的情况，忽略
	}
};

/** 工具参数：只取头部（JSON 的关键字段在前） */
const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n)}…(+${s.length - n})`);

/**
 * 工具结果：头 70% + 尾 30%。
 * bash 的 exit code / 报错 / 栈底都在末尾，只取头会把「失败了」这个消息整个切掉。
 */
const makeClipTail = (limit: number) => {
	const head = Math.round(limit * 0.7);
	const tail = limit - head;
	return (s: string) => {
		if (s.length <= limit) return s;
		const cut = s.length - limit;
		// 只超一点点：截头就够，不值得为几十个字插两个标记
		if (cut < tail) return `${s.slice(0, limit)}…(+${cut})`;
		return `${s.slice(0, head)}…(+${cut})…${s.slice(-tail)}`;
	};
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

const makeText =
	(clipTail: (s: string) => string) =>
	(c: unknown): string =>
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

/**
 * 取出「还没被折叠」的那段条目。
 *
 * event.branchEntries 是整个分支（根 → 叶），上一轮被压掉的消息也在里面 ——
 * 它们已经变成 previousSummary 的一段文本了。如果从头渲染，第 2 轮就会把
 * 同一批内容再渲染一遍（实测摘要膨胀 3.4 倍，第 3 轮更糟）。
 *
 * 所以找到最后一个 compaction 条目，从它的 firstKeptEntryId 开始算。
 * 找不到那个 id（比如上轮用了 compact-all 的空串哨兵）就从 compaction 之后开始。
 */
const liveFromLastCompaction = (branch: any[]) => {
	let start = 0;
	for (let i = branch.length - 1; i >= 0; i--) {
		if (branch[i].type !== "compaction") continue;
		const keepId = branch[i].firstKeptEntryId;
		const ki = keepId ? branch.findIndex((e: any) => e.id === keepId) : -1;
		start = ki >= 0 ? ki : i + 1;
		break;
	}
	return branch.slice(start).filter(isVisible);
};

const makeRender =
	(toolChars: number) =>
	(entries: any[], ref: Map<string, number>): string => {
		const clipTail = makeClipTail(toolChars);
		const text = makeText(clipTail);
		const out: string[] = [];
		for (const e of entries) {
			const r = ref.get(e.id);
			const t = r == null ? "" : `#${r}`; // 编号跟标题走，不和正文混
			if (e.type === "branch_summary") {
				// pi 会把它变成一条 user 消息（BRANCH_SUMMARY_PREFIX 包裹），这里直接给正文
				if (!e.summary) continue;
				out.push(`[user${t}]\n${esc(e.summary)}`);
				continue;
			}
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
							out.push(`* ${p.name}${t} ${clip(esc(JSON.stringify(p.arguments ?? {})), toolChars)}`);
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
	pi.on("session_start", () => {
		scaffoldConfig();
	});

	pi.on("session_before_compact", (event, ctx) => {
		const notify = (message: string, kind: "info" | "warning" = "info") => {
			if (ctx.hasUI) ctx.ui.notify(message, kind);
		};

		try {
			// event.branchEntries 是「从根到叶子」的全部条目，里面还躺着上一轮已经折进
			// previousSummary 的那批消息。不跳过它们就会重复渲染：第 2 轮摘要 = 上轮摘要
			// + 全部历史渲染，越压越大。所以从最后一个 compaction 的 firstKeptEntryId 起算。
			const live = liveFromLastCompaction(event.branchEntries);

			// 切点直接用 pi 算好的那个：它按 compaction.keepRecentTokens（默认 20000 tok）
			// 从末尾往回累加，并且保证落在合法边界上（不会把 toolCall 和 toolResult 拆开）。
			// 我们不重复实现这套逻辑，只负责把切点之前的内容渲染成文本。
			const cut = live.findIndex((e: any) => e.id === event.preparation.firstKeptEntryId);
			if (cut <= 0) {
				// cut === 0：pi 说一条都不用压（本来也不会调到这里）
				// cut === -1：切点不在可见条目里，说明这一轮没得压
				notify("这一轮没有可压缩的内容，已跳过", "warning");
				return { cancel: true };
			}

			const { toolChars } = loadConfig();
			const body = makeRender(toolChars)(live.slice(0, cut), buildRefs(ctx.sessionManager.getEntries()));
			if (!body.trim()) {
				notify("待压缩的历史渲染为空，已取消", "warning");
				return { cancel: true };
			}

			// 多轮：上一轮的摘要原样前置（剥掉它自己的格式说明和尾注，避免每轮累加）
			const prev = event.preparation.previousSummary?.replace(FORMAT_RE, "").replace(TAIL_RE, "").trim();
			const summary = `${FORMAT_NOTE}\n\n${prev ? `${prev}\n\n---\n\n` : ""}${body}\n\n---\n${TAIL_NOTE}`;

			return {
				compaction: {
					summary,
					// 原样用 pi 的切点
					firstKeptEntryId: event.preparation.firstKeptEntryId,
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
