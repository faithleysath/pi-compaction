/**
 * pi-compaction — 用「过滤 + 截断」代替 pi 的 LLM 摘要。
 *
 * 触发时机和切点都交给 pi（自动阈值 / 溢出恢复 / 手动 /compact），只替换压缩过程：
 *   切点 = event.preparation.firstKeptEntryId（pi 按 compaction.keepRecentTokens 算好的，默认 20000 tok）
 *   用户消息原文保留 / 助手正文原文保留 / thinking 丢弃 / 图片只留 [image png] 占位
 *   工具参数的截断长度、工具结果的头/尾长度各自可配（~/.pi/agent/pi-compaction.json）
 *   编号在标题行里：[user#1] / [assistant#2] / * read#2 / →#3，可用 recall 取原文
 *
 * 铁律：永远不 return undefined / 不抛错给 pi —— 那两条路径都会落到 pi 的默认 LLM 摘要。
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { convertToLlm, getAgentDir } from "@earendil-works/pi-coding-agent";

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

const makeRender =
	(cfg: ClipConfig) =>
	(entries: any[], ref: Map<string, number>): string => {
		const clipResult = (s: string) => clipHeadTail(s, cfg.toolResultHead, cfg.toolResultTail);
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
				out.push(`[user${t}] $ ${esc(msg.command)}\n${clipResult(esc(msg.output ?? ""))}`);
				continue;
			}
			for (const m of convertToLlm([msg])) {
				if (m.role === "user") out.push(`[user${t}]\n${esc(text(m.content))}`);
				else if (m.role === "toolResult") out.push(`→${t} ${clipResult(esc(text(m.content)))}`);
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

			const cfg = loadConfig();
			const body = makeRender(cfg)(live.slice(0, cut), buildRefs(ctx.sessionManager.getEntries()));
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
