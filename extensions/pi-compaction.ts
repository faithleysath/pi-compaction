/**
 * pi-compaction — 用「过滤 + 截断」代替 pi 的 LLM 摘要。
 *
 * 触发时机和切点都交给 pi（自动阈值 / 溢出恢复 / 手动 /compact），只替换压缩过程：
 *   切点 = event.preparation.firstKeptEntryId（pi 按 compaction.keepRecentTokens 算好的，默认 20000 tok）
 *   渲染源 = buildSessionProjection()，和 pi 自己喂给 LLM 的是同一份投影：
 *           被 context_edit 省略/替换过的内容按投影后的样子渲染，不会把 pi 刻意丢掉的东西复活
 *   用户消息原文保留 / 助手正文原文保留 / thinking 丢弃 / 图片只留 [image png] 占位
 *   工具参数的截断长度、工具结果的头/尾长度各自可配（~/.pi/agent/pi-compaction.json）
 *   编号在标题行里：[user#1] / [assistant#2] / * read#2 / →#3，可用 recall 取原文
 *
 * 铁律：永远不 return undefined / 不抛错给 pi —— 那两条路径都会落到 pi 的默认 LLM 摘要。
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildSessionProjection, getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * 三个截断长度，单位都是字符（不是 token）。
 *
 * - toolArgs：工具参数的头部长度。JSON 的关键字段（command / path / pattern）都在前面。
 * - toolResultHead / toolResultTail：工具结果的头尾长度。bash 的 exit code、报错、栈底
 *   都在末尾，只取头会把「失败了」这条消息整个切掉。
 *
 * 实测本机 toolResult 的 p50 = 411、p90 = 6333，默认 200 + 100 能覆盖一半以上。
 */
const DEFAULTS = {
	toolArgs: 300,
	toolResultHead: 200,
	toolResultTail: 100,
	/** 多轮压缩时，把旧轮次里的工具调用折成一行「调用工具 N 次 #a–#b」，只有最新一轮保留细节 */
	collapseOldTools: true,
};

const CONFIG_PATH = join(getAgentDir(), "pi-compaction.json");

type ClipConfig = typeof DEFAULTS;

const isCharCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/**
 * 读配置。每次压缩读一次（压缩很少发生，开销可以忽略），这样改完配置不用重启。
 * 单项非法就用该项的默认值，整个文件坏了就用全部默认值 —— 绝不因为配置问题影响压缩。
 */
const loadConfig = (): ClipConfig => {
	let raw: any;
	try {
		raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
	} catch {
		return { ...DEFAULTS };
	}
	// 老版本只有一个 toolChars：按 70% / 30% 拆成头尾，工具参数沿用它
	if (raw?.toolChars !== undefined) {
		const n = raw.toolChars;
		if (isCharCount(n) && n > 0) {
			const head = Math.round(n * 0.7);
			return { toolArgs: n, toolResultHead: head, toolResultTail: n - head, collapseOldTools: DEFAULTS.collapseOldTools };
		}
	}
	return {
		toolArgs: isCharCount(raw?.toolArgs) ? raw.toolArgs : DEFAULTS.toolArgs,
		toolResultHead: isCharCount(raw?.toolResultHead) ? raw.toolResultHead : DEFAULTS.toolResultHead,
		toolResultTail: isCharCount(raw?.toolResultTail) ? raw.toolResultTail : DEFAULTS.toolResultTail,
		collapseOldTools: typeof raw?.collapseOldTools === "boolean" ? raw.collapseOldTools : DEFAULTS.collapseOldTools,
	};
};

/** 第一次跑的时候生成一份默认配置，省得用户不知道有这个开关 */
const scaffoldConfig = () => {
	if (existsSync(CONFIG_PATH)) return;
	try {
		writeFileSync(CONFIG_PATH, `${JSON.stringify(DEFAULTS, null, 2)}\n`);
	} catch {
		// 只读文件系统之类的情况，忽略
	}
};

/** 只保留头部 n 个字符（工具参数用） */
const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n)}…(+${s.length - n})`);

/** 保留头 head 个 + 尾 tail 个（工具结果用）。头尾都是 0 时会退化成只剩一个截断标记 */
const clipHeadTail = (s: string, head: number, tail: number) => {
	if (s.length <= head + tail) return s;
	const cut = s.length - head - tail;
	const h = s.slice(0, head);
	const t = tail > 0 ? s.slice(-tail) : "";
	return `${h}…(+${cut})${tail > 0 ? "…" : ""}${t}`;
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
		.replace(/^(\[user(?=[#\]])|\[assistant(?=[#\]])|\* |→(?=[ #]))/gm, "\\$1")
		// 正文里独立成行的 ---：它不是轮分隔符，不转义会被折叠函数当块边界，
		// 把一条工具结果劈成两半（后半截丢掉 →#N 前缀，裸着掉出来）
		.replace(/^---\s*$/gm, "\\---");

/**
 * 摘要开头的一行格式说明。实测（本机 24 次）：不加时模型只有 ~60% 能分清
 * 「条目」和「正文里长得像条目的字面文本」，加上后 20/24、12/12。
 * 84 字符 ≈ 21 token，比把正文全部缩进（+743 token）便宜得多。
 */
const FORMAT_NOTE =
	"格式：以 [user#N] / [assistant#N] / * 工具#N / →#N 开头的行是条目（行首无反斜杠）；其余是上一条的正文；带反斜杠的是正文字面文本；「（调用工具 N 次 #a–#b）」是已折叠的旧工具调用，原文用 recall range 取。";

/** 上一轮末尾的提示语，拼接前剥掉，不然每轮累加一份 */
const TAIL_NOTE = "可用 recall 工具按 #N 取原文；图片可加 image:true 取回。";
const TAIL_RE = /\n*---\n可用 recall 工具按 #N 取原文[^\n]*\n?\s*$/;
/** 剥掉首行的格式说明。用前缀匹配而不是整串，改措辞也不会让旧摘要剥不掉 */
const FORMAT_RE = /^格式：[^\n]*\n*/;

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

/**
 * 多轮压缩时折叠旧轮次的工具调用。
 *
 * 上一轮的摘要原样前置进来，里面每条工具调用和结果都是两三行文本 —— 轮次一多，
 * 摘要就被这些历史细节撑爆。这里把**连续的工具调用块**合并成一行
 * 「（调用工具 N 次 #a–#b）」，用户消息和助手正文一字不动。
 *
 * 只处理 `* name#N ...` 和 `→#N ...` 开头的块。正文里长得像条目的行早被 esc()
 * 加了反斜杠，不会误伤（`\* ` 不匹配 `^\* `）。
 */
const collapseToolBlocks = (text: string, marker: (run: { calls: number; lo: number; hi: number }) => string) => {
	// 一个块 = 一个条目，从「行首是结构标记」到下一个结构标记为止
	const NEW_BLOCK = /^(\[user(?=[#\]])|\[assistant(?=[#\]])|\* |→(?=[ #])|---\s*$)/;
	const isToolLine = (l: string) => /^(\* |→(?=[ #]))/.test(l);

	const lines = text.split("\n");
	type Block = { tool: boolean; lines: string[] };
	const blocks: Block[] = [];
	let cur: Block | null = null;
	for (const line of lines) {
		if (NEW_BLOCK.test(line)) {
			if (cur) blocks.push(cur);
			cur = { tool: isToolLine(line), lines: [line] };
		} else if (cur) cur.lines.push(line);
		else cur = { tool: false, lines: [line] };
	}
	if (cur) blocks.push(cur);

	const out: string[] = [];
	let run: Block[] = [];
	const flush = () => {
		if (!run.length) return;
		let calls = 0;
		const nums: number[] = [];
		for (const b of run) {
			const head = b.lines[0];
			if (head.startsWith("* ")) calls++;
			const m = head.match(/#(\d+)/);
			if (m) nums.push(Number(m[1]));
		}
		if (calls === 0) {
			// 只有结果行（正常不会发生），原样吐回去
			for (const b of run) out.push(b.lines.join("\n"));
		} else {
			out.push(marker({ calls, lo: Math.min(...nums), hi: Math.max(...nums) }));
		}
		run = [];
	};
	for (const b of blocks) {
		if (b.tool) {
			run.push(b);
			continue;
		}
		flush();
		out.push(b.lines.join("\n").replace(/\n+$/, ""));
	}
	flush();
	return out.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
};

/** `!cmd` 的执行状态尾巴。pi 自己的 bashExecutionToText 就是这么写的，别丢 */
const bashStatus = (m: any) => {
	const parts: string[] = [];
	if (m.cancelled) parts.push("(command cancelled)");
	else if (m.exitCode !== null && m.exitCode !== undefined && m.exitCode !== 0) parts.push(`Command exited with code ${m.exitCode}`);
	if (m.truncated && m.fullOutputPath) parts.push(`[Output truncated. Full output: ${m.fullOutputPath}]`);
	return parts.length ? `\n\n${parts.join("\n")}` : "";
};

/**
 * 把「投影后的条目」渲染成摘要正文。
 *
 * 输入是 buildSessionProjection().entries —— 每个条目带着它**实际进上下文的 messages**：
 *   - 被 context_edit 省略（replacement: null）的条目，messages 是空的 → 自然跳过
 *   - 被 context_edit 替换的条目，messages 里是替换后的内容 → 渲染的就是替换后的样子
 *   - 上一轮的 compaction 条目，messages 是 [system, compactionSummary] → 跳过（走 previousSummary）
 *
 * 编号仍然按 raw entries 里的 `type === "message"` 数，和 recall 完全一致。
 */
const makeRender =
	(cfg: ClipConfig) =>
	(entries: { sourceEntry: any; messages: any[] }[], ref: Map<string, number>): string => {
		const clipResult = (s: string) => clipHeadTail(s, cfg.toolResultHead, cfg.toolResultTail);
		const out: string[] = [];

		for (const { sourceEntry: src, messages } of entries) {
			if (src.type === "compaction") continue; // 上轮摘要，由 previousSummary 负责
			const r = ref.get(src.id);
			const t = r == null ? "" : `#${r}`; // 编号跟标题走，不和正文混

			for (const m of messages) {
				const role = m.role;

				if (role === "system" || role === "compactionSummary") continue;

				if (role === "branchSummary") {
					// pi 把它变成一条 user 消息（BRANCH_SUMMARY_PREFIX 包裹），这里直接给正文
					if (!m.summary) continue;
					out.push(`[user${t}]\n${esc(m.summary)}`);
					continue;
				}

				if (role === "custom") {
					// 别的扩展注进去的通知：没有编号（它不是 type === "message" 条目）
					out.push(`[user]\n${esc(text(m.content))}`);
					continue;
				}

				if (role === "bashExecution") {
					// 用户敲的 ! 命令：命令原文，输出头+尾截断，末尾补退出状态
					// !! 开头（excludeFromContext）的是「只要结果、不进上下文」，pi 会丢掉，我们也得丢
					if (m.excludeFromContext) continue;
					out.push(`[user${t}] $ ${esc(m.command)}\n${clipResult(esc(m.output ?? ""))}${bashStatus(m)}`);
					continue;
				}

				if (role === "user") {
					out.push(`[user${t}]\n${esc(text(m.content))}`);
				} else if (role === "toolResult") {
					out.push(`→${t} ${clipResult(esc(text(m.content)))}`);
				} else if (role === "assistant" && Array.isArray(m.content)) {
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
							out.push(`* ${p.name}${t} ${clip(esc(JSON.stringify(p.arguments ?? {})), cfg.toolArgs)}`);
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
			// 渲染源用 pi 自己的投影：buildSessionProjection 会应用 context_edit、
			// 只保留最新 compaction 之后的条目。这样我们看到的和模型看到的是同一份历史 ——
			// 被省略的失败尝试不会复活，被替换过的内容按替换后的样子进摘要。
			const proj = buildSessionProjection(event.branchEntries);

			// 切点直接用 pi 算好的那个。注意要在**未过滤**的投影条目里找：
			// pi 的切点可以落在 context_edit 之类的空条目上，先过滤就永远找不到。
			const cut = proj.entries.findIndex((e: any) => e.sourceEntry.id === event.preparation.firstKeptEntryId);
			if (cut <= 0) {
				// cut === 0：切点落在第一条，前面没东西可压
				// cut === -1：切点不在投影里（理论上不会发生）
				notify("这一轮没有可压缩的内容，已跳过", "warning");
				return { cancel: true };
			}

			const cfg = loadConfig();
			const body = makeRender(cfg)(proj.entries.slice(0, cut), buildRefs(ctx.sessionManager.getEntries()));
			if (!body.trim()) {
				notify("待压缩的历史渲染为空，已取消", "warning");
				return { cancel: true };
			}

			// 多轮：上一轮的摘要原样前置（剥掉它自己的格式说明和尾注，避免每轮累加）
			let prev = event.preparation.previousSummary?.replace(FORMAT_RE, "").replace(TAIL_RE, "").trim();

			// 折叠旧轮次的工具调用：只有最新一轮（body）保留完整细节
			if (prev && cfg.collapseOldTools) {
				prev = collapseToolBlocks(prev, ({ calls, lo, hi }) =>
					`（调用工具 ${calls} 次 ${lo === hi ? `#${lo}` : `#${lo}–#${hi}`}）`,
				);
			}

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
