/**
 * pi-recall — 按 #N 回查被压缩掉的原文。配合 pi-compaction.ts 使用。
 *
 * 编号规则与 pi-compaction 完全一致：会话里第 N 个 type==="message" 条目
 * （append-only，永不复用；role:"system" 的 loadout 也占号但不渲染）。
 *
 * 只在当前 session 内可查，且只走内存里的 getEntries()，不碰文件。
 *
 * expand 可以一次给多个编号（批量召回）；image: true 时把原文里的图片块也一起带回来。
 */

import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PAGE = 5;

/** 一次最多带回多少张图 —— 本机实测中位数一张 446 KB、p99 2.6 MB，不设上限能把上下文撑爆 */
const MAX_IMAGES = 6;
/** 单次照片总字节上限（base64 后），超了就停，避免一次 recall 把请求体顶到几十 MB */
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
/**
 * 单次 expand 的文本上限（字符）。本机最大的单条 toolResult 是 129,036 字符 ≈ 32k tok，
 * 不限量的话 expand:[1..100] 能把 1M 窗口一次吃掉。默认 60k 字符 ≈ 15k tok。
 */
const MAX_TEXT_CHARS = 60_000;

/**
 * slice 的分块上限。比 expand 的 60k 略小 —— 每次 slice 还会带 5 行元数据，
 * 而且要留出继续读的空间，别让一次分块就顶到 expand 的整条上限。
 */
const MAX_SLICE_CHARS = 50_000;
const DEFAULT_SLICE_CHARS = 20_000;
/** 分块边界向回找换行的最大距离：再远就不值得为对齐牺牲这么多了 */
const SNAP_WINDOW = 200;

const isHighSurrogate = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLowSurrogate = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/** 抽一条消息里的图片块 */
const imagesOf = (msg: any): { data: string; mimeType: string }[] => {
	if (!msg || msg.role === "excluded") return [];
	const c = msg.content;
	if (!Array.isArray(c)) return [];
	return c.filter((p: any) => p && p.type === "image" && typeof p.data === "string");
};

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

/**
 * 一条消息 → 纯文本（assistant 带 toolCall 名与参数，toolResult 带全文）。
 *
 * `full: true` 不截断，`full: false` 截到 800 字符 —— 后者只用于预览。
 * **搜索必须用 full: true**：本机 99% 的超长消息在 800 字符之后还有实质内容，
 * 拿预览文本去搜等于只看前 800 字。
 */
const render = (msg: any, full: boolean): string => {
	const cap = full ? Infinity : 800;
	const cut = (s: string) => (s.length <= cap ? s : `${s.slice(0, cap)}…(+${s.length - cap})`);
	if (!msg) return "";
	if (msg.role === "excluded") return "(this entry is a !! command; its content was excluded from context and is not available)";
	// 别的扩展注入的通知：带上 customType，才能分清是后台任务还是别的东西
	if (msg.role === "custom") return `[${msg.customType ?? "custom"} notice]\n${cut(text(msg.content))}`;
	if (msg.role === "user") return `[user]\n${cut(text(msg.content))}`;
	if (msg.role === "bashExecution") return `[user] $ ${msg.command}\n${cut(msg.output ?? "")}`;
	if (msg.role === "toolResult") return `[toolResult:${msg.toolName}]\n${cut(text(msg.content))}`;
	if (msg.role === "assistant") {
		const parts: string[] = [];
		for (const p of Array.isArray(msg.content) ? msg.content : []) {
			if (p.type === "text") parts.push(p.text);
			else if (p.type === "thinking") parts.push(`[thinking] ${full ? p.thinking : cut(p.thinking ?? "")}`);
			else if (p.type === "image") parts.push(imgTag(p.mimeType));
			else if (p.type === "toolCall") parts.push(`[toolCall:${p.name}] ${cut(JSON.stringify(p.arguments ?? {}))}`);
		}
		return `[assistant]\n${parts.join("\n")}`;
	}
	return `[${msg.role}]\n${cut(text(msg.content))}`;
};

/** 宽松取整：模型传 "40000" / 4e4 / 40000.7 都认，真的不是数字才回 null */
const intOrNull = (v: unknown): number | null => {
	const n = typeof v === "string" ? Number(v.trim()) : v;
	return typeof n === "number" && Number.isFinite(n) ? Math.floor(n) : null;
};

/** Schema 层也允许数字字符串，否则 "40000" 在进 execute 之前就被挡掉了 */
const NumLike = (description: string) => Type.Union([Type.Number(), Type.String()], { description });

/**
 * 切一块 [start, end)。三条硬约束：
 * 1. start < end <= full.length（`offset < total` 时）—— 否则 next_offset 不前进，模型会死循环；
 * 2. 起点和终点都落在码元边界上：终点尽量对齐换行、绝不对齐到代理对中间；
 *    起点只在手写 offset 落在代理对中间时触发，退到高代理项（宁可重叠 1 码元也不丢字）；
 * 3. 绝不拆代理对。碰上就向后多拿 1 个码元（即实际可能比 limit 多 1）——
 *    孤立代理项跨过 JSON / 传输层 / 模型编码可能变成 U+FFFD，宁可多 1 码元也不能伤字；
 *    向前多拿天然保住约束 1，不需要再为了进展去拆字。
 */
const sliceChunk = (full: string, offset: number, limit: number) => {
	const total = full.length;
	let start = Math.min(Math.max(0, offset), total);
	// 起点对齐：next_offset 永远是合法边界，这里只挡手写的 offset
	if (start > 0 && start < total && isLowSurrogate(full.charCodeAt(start)) && isHighSurrogate(full.charCodeAt(start - 1))) start--;
	let end = Math.min(start + limit, total);
	if (end < total) {
		const nl = full.lastIndexOf("\n", end - 1);
		if (nl > start && nl >= end - SNAP_WINDOW) end = nl + 1;
		if (end < total && isHighSurrogate(full.charCodeAt(end - 1)) && isLowSurrogate(full.charCodeAt(end))) end++;
	}
	// 兜底：上面的调整只会前移（换行对齐不低于 start，代理对只增不减），保留一行防守避免意外的死循环
	if (start < total && end <= start) end = Math.min(start + limit, total);
	return { start, end, total, chunk: full.slice(start, end), hasMore: end < total };
};

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "recall",
		label: "Recall",
		description: [
			"Read the original text of messages that compaction replaced with a truncated summary.",
			"Pick one per call:",
			"- expand: [N, ...] — full untruncated text of those entries (a toolCall also returns its paired result).",
			"- range: [from, to] — entries #from..#to in order, 5 per page.",
			"- query: keywords — search the whole session, 5 hits per page, ranked.",
			`- slice: {message: N, offset?, limit?} or {notice: N, offset?, limit?} — one entry's raw text, one chunk at a time (default ${DEFAULT_SLICE_CHARS} chars, max ${MAX_SLICE_CHARS}).`,
			"",
			`expand and notices stop at ${MAX_TEXT_CHARS} chars. When that happens they print the exact slice call to continue from. Pass its next_offset back into slice until has_more is false.`,
			"Use the next_offset value as given — do not compute your own offsets. Chunks are aligned to line and emoji boundaries, so hand-computed offsets drift and skip text.",
			"Only continue if you actually need the rest — re-reading a huge log refills the context compaction just freed.",
			"If you don't know the #N, search with query first — don't guess it.",
			"Skip recall when the summary already answers; don't bulk-restore logs you don't need.",
			"expand accepts several numbers at once (batch). Add image: true to get the real image blocks.",
			"#N is the number shown in summary headers like [user#12] / * read#12 / →#13. Only the current session is searchable.",
			"Extension-injected notifications (e.g. pi-bg-bash completion / watch output) are not messages, so they have no #N: pass their index in notices to read one in full.",
		].join("\n"),
		parameters: Type.Object({
			expand: Type.Optional(Type.Array(Type.Number(), { description: "Entry indices (#N, e.g. 12 for [user#12]) to return in full." })),
			range: Type.Optional(
				Type.Array(Type.Number(), { minItems: 2, maxItems: 2, description: "[from, to]: entries #from..#to inclusive." }),
			),
			query: Type.Optional(Type.String({ description: "Keywords to search for across the session (includes extension notifications)." })),
			notices: Type.Optional(
				Type.Array(Type.Number(), { description: "Notification indices (N shown as 'notice#N' in query hits) to return in full. These are custom_message entries and do not have a message #N." }),
			),
			page: Type.Optional(Type.Number({ description: "Page number for range or query, 1-based. Default 1." })),
			slice: Type.Optional(
				Type.Object({
					message: Type.Optional(NumLike("Message entry #N (e.g. 42 for [user#42]). Give this or notice, not both.")),
					notice: Type.Optional(NumLike("Notification index (N in notice#N). Give this or message, not both.")),
					offset: Type.Optional(NumLike("Character offset to start at (0-based). Default 0. Usually the next_offset from the previous chunk.")),
					limit: Type.Optional(
						NumLike(`Max characters to return. Default ${DEFAULT_SLICE_CHARS}, clamped to ${MAX_SLICE_CHARS}.`),
					),
				}),
			),
			image: Type.Optional(
				Type.Boolean({
					description: `Return the actual image attachments of the recalled entries, not just [image png] placeholders. Costs real tokens (a screenshot is often 100+ KB). Max ${MAX_IMAGES} images / ${MAX_IMAGE_BYTES / 1024 / 1024} MB per call.`,
				}),
			),
		}),
		async execute(_id, params: any, _signal, _onUpdate, ctx) {
			const entries = ctx.sessionManager.getEntries() as any[];
			const msgs: { n: number; msg: any }[] = [];
			let n = 0;
			for (const e of entries) {
				if (e.type !== "message" || !e.message) continue;
				// !! 命令（excludeFromContext）占号但内容不进上下文 —— 这里也不许吐
				if (e.message.role === "bashExecution" && e.message.excludeFromContext) {
					msgs.push({ n: n++, msg: { role: "excluded" } });
					continue;
				}
				msgs.push({ n: n++, msg: e.message });
			}
			const byN = new Map(msgs.map((m) => [m.n, m.msg]));

			// 扩展注入的通知（custom_message）不占 #N —— 编号空间要和 compaction 完全一致，
			// 多一个就全错位。所以单独给一套 notice#N：只用于 query 命中和 notices 参数。
			const notices: { n: number; customType: string; content: any }[] = [];
			for (const e of entries) {
				if (e.type !== "custom_message") continue;
				notices.push({ n: notices.length, customType: e.customType ?? "custom", content: e.content });
			}
			const byNotice = new Map(notices.map((x) => [x.n, x]));

			const page = Math.max(1, Math.floor(params.page ?? 1));

			const asText = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: undefined });

			// slice：单条入口的精确分块读取（offset/limit 都算字符）。
			// 单独一个参数而不是给 expand 加 offset：expand 一次可以给多个编号、还会自动带 toolResult，
			// 共享 offset 的话“从哪里开始”根本不知道指谁。
			if (params.slice && typeof params.slice === "object") {
				const s = params.slice as any;
				const hasMsg = s.message !== undefined && s.message !== null;
				const hasNotice = s.notice !== undefined && s.notice !== null;
				if (hasMsg && hasNotice) return asText(`give exactly one of slice.message / slice.notice`);
				if (!hasMsg && !hasNotice) return asText(`give slice.message (#N) or slice.notice (notice#N), plus optional offset / limit`);

				const rawOffset = intOrNull(s.offset);
				const offset = Math.max(0, rawOffset ?? 0);
				const rawLimit = intOrNull(s.limit);
				const asked = rawLimit === null || rawLimit <= 0 ? DEFAULT_SLICE_CHARS : rawLimit;
				const limit = Math.min(asked, MAX_SLICE_CHARS);

				let label: string;
				let full: string;
				let hint: (next: number) => string;
				if (hasMsg) {
					const idx = intOrNull(s.message);
					const msg = idx === null ? undefined : byN.get(idx);
					if (idx === null || !msg) return asText(`#${s.message}: no such entry`);
					label = `#${idx}`;
					full = render(msg, true);
					hint = (next) => `next: {"slice":{"message":${idx},"offset":${next}}}`;
				} else {
					const idx = intOrNull(s.notice);
					const x = idx === null ? undefined : byNotice.get(idx);
					if (idx === null || !x) return asText(`notice#${s.notice}: no such notification`);
					label = `notice#${idx}`;
					full = render({ role: "custom", customType: x.customType, content: x.content }, true);
					hint = (next) => `next: {"slice":{"notice":${idx},"offset":${next}}}`;
				}

				const total = full.length;
				if (offset > total) {
					return asText(
						`${label}\ntotal_chars: ${total}\noffset: ${offset}\nhas_more: false\noffset ${offset} is past total_chars ${total} (largest usable offset is ${total})\n\n(end of this entry, nothing left to read)`,
					);
				}

				const { start, end, chunk, hasMore } = sliceChunk(full, offset, limit);
				const pct = total === 0 ? 100 : Math.floor((end / total) * 100);
				const meta = [`total_chars: ${total}`, `offset: ${start}`];
				if (start !== offset) meta.push(`(offset ${offset} fell inside an emoji; snapped back to code-unit boundary ${start})`);
				if (limit !== asked) meta.push(`limit: ${limit} (asked for ${asked}; clamped to ${MAX_SLICE_CHARS})`);
				meta.push(
					`returned_chars: ${chunk.length}`,
					`next_offset: ${hasMore ? end : "null"}`,
					`has_more: ${hasMore}`,
					`progress: ${pct}%`,
				);
				const parts = [`${label}\n${meta.join("\n")}`, `--- CONTENT START ---\n${chunk}\n--- CONTENT END ---`];
				if (hasMore) parts.push(hint(end));
				else parts.push("(end of this entry)");
				return asText(parts.join("\n\n"));
			}

			// notices：按 notice#N 取单条通知全文
			if (Array.isArray(params.notices) && params.notices.length > 0) {
				const chunks: string[] = [];
				let budget = MAX_TEXT_CHARS;
				for (const raw of params.notices) {
					const idx = Number(raw);
					const x = byNotice.get(idx);
					if (!x) {
						chunks.push(`notice#${idx}: no such notification`);
						continue;
					}
					const full = render({ role: "custom", customType: x.customType, content: x.content }, true);
					if (full.length <= budget) {
						budget -= full.length;
						chunks.push(`notice#${x.n}\n${full}`);
					} else {
						const take = Math.max(0, budget);
						budget = 0;
						chunks.push(
							`notice#${x.n}\n${full.slice(0, take)}…(+${full.length - take}, over the ${MAX_TEXT_CHARS}-char limit)\nnext: {"slice":{"notice":${x.n},"offset":${take}}}`,
						);
					}
				}
				return { content: [{ type: "text", text: chunks.join("\n\n---\n\n") }], details: undefined };
			}

			// expand（批量：一次可以给多个编号，可带回原始图片块）
			if (Array.isArray(params.expand) && params.expand.length > 0) {
				const wantImage = params.image === true;
				const content: any[] = [];
				const chunks: string[] = []; // 文本先攒着，遇到图片再落地
				let imgBudget = MAX_IMAGES;
				let byteBudget = MAX_IMAGE_BYTES;
				let sawImage = false;

				const emit = (t: string) => chunks.push(t);
				const flush = () => {
					if (chunks.length) content.push({ type: "text", text: chunks.join("\n\n---\n\n") });
					chunks.length = 0;
				};
				const attach = (msg: any, label: string) => {
					if (!wantImage) return;
					const imgs = imagesOf(msg);
					if (!imgs.length) return;
					sawImage = true;
					const take: any[] = [];
					for (const b of imgs) {
						if (take.length >= imgBudget || b.data.length > byteBudget) break;
						byteBudget -= b.data.length;
						take.push(b);
					}
					imgBudget -= take.length;
					const more = imgs.length - take.length;
					if (take.length === 0) {
						emit(`${label}: has ${imgs.length} images but hit the per-call cap (${MAX_IMAGES} images / ${MAX_IMAGE_BYTES / 1024 / 1024} MB); none returned`);
						return;
					}
					emit(`${label}: attached ${take.length} images${more > 0 ? ` (${more} more over the cap)` : ""}`);
					flush();
					for (const b of take) content.push({ type: "image", data: b.data, mimeType: b.mimeType });
				};

				const done = new Set<number>(); // 同一个编号只输出一次（批量里点了 #2 又点了 #3 时别重复）
				let textBudget = MAX_TEXT_CHARS; // 整个 expand 共享一个文本预算
				let truncated = 0; // 有多少条因为预算没给全
				const show = (n: number, msg: any, heading: string) => {
					done.add(n);
					const full = render(msg, true);
					if (full.length <= textBudget) {
						textBudget -= full.length;
						emit(`${heading}\n${full}`);
					} else {
						// 截多少就报多少 offset —— 批量 expand 里每条拿到的份额不一样，
						// 统一报 offset:60000 会让 #42 后面的内容永远读不到。
						const take = Math.max(0, textBudget);
						textBudget = 0;
						truncated++;
						const cont = `next: {"slice":{"message":${n},"offset":${take}}}`;
						emit(
							take > 0
								? `${heading}\n${full.slice(0, take)}…(+${full.length - take}, over the ${MAX_TEXT_CHARS}-char limit)\n${cont}`
								: `${heading}\n(omitted ${full.length} chars: this expand already hit the ${MAX_TEXT_CHARS}-char limit)\n${cont}`,
						);
					}
					attach(msg, `#${n}`);
				};

				for (const raw of params.expand) {
					const idx = Number(raw);
					const msg = byN.get(idx);
					if (!msg) {
						emit(`#${idx}: no such entry`);
						continue;
					}
					if (!done.has(idx)) show(idx, msg, `#${idx}`);
					// toolCall 配对的 toolResult
					if (msg.role === "assistant") {
						const ids = (Array.isArray(msg.content) ? msg.content : [])
							.filter((p: any) => p.type === "toolCall")
							.map((p: any) => p.id);
						for (const m of msgs) {
							if (m.msg.role === "toolResult" && ids.includes(m.msg.toolCallId) && !done.has(m.n)) {
								show(m.n, m.msg, `#${m.n} (result of #${idx})`);
							}
						}
					}
				}
				if (wantImage && !sawImage) emit("(no images in these entries)");
				if (truncated > 0)
					emit(`(${truncated} entries were truncated at the ${MAX_TEXT_CHARS}-char limit; each one above prints the exact slice call to continue)`);
				flush();
				return { content, details: undefined };
			}

			// range
			if (Array.isArray(params.range) && params.range.length === 2) {
				const from = Math.min(Number(params.range[0]), Number(params.range[1]));
				const to = Math.max(Number(params.range[0]), Number(params.range[1]));
				const slice = msgs.filter((m) => m.n >= from && m.n <= to);
				const start = (page - 1) * PAGE;
				const pageSlice = slice.slice(start, start + PAGE);
				const totalPages = Math.max(1, Math.ceil(slice.length / PAGE));
				const body = pageSlice.map((m) => `#${m.n}\n${render(m.msg, false)}`).join("\n\n");
				const more =
					page < totalPages ? `\n\n--- page ${page}/${totalPages}: use page:${page + 1} for more ---` : "";
				const content: any[] = [{ type: "text", text: (body + more) || "empty range" }];
				if (params.image === true) {
					let count = 0;
					let bytes = MAX_IMAGE_BYTES;
					for (const m of pageSlice) {
						for (const b of imagesOf(m.msg)) {
							if (count >= MAX_IMAGES || b.data.length > bytes) continue;
							bytes -= b.data.length;
							count++;
							content.push({ type: "image", data: b.data, mimeType: b.mimeType });
						}
					}
				}
				return { content, details: undefined };
			}

			// query
			if (typeof params.query === "string" && params.query.trim()) {
				// 单字符关键词也允许（中文里一个字经常就是关键词）
				const terms = params.query.toLowerCase().split(/\s+/).filter((t: string) => t.length > 0);
				type Hit = { label: string; n: number; msg: any; score: number; body: string };
				const scoreOf = (body: string) => {
					let score = 0;
					for (const t of terms) {
						const c = body.split(t).length - 1;
						if (c > 0) score += 1 + Math.log(c);
					}
					return score;
				};
				const msgHits: Hit[] = msgs.map((m) => {
					// 搜索走全文，不用预览用的 800 字符截断
					const body = render(m.msg, true).toLowerCase();
					return { label: `#${m.n}`, n: m.n, msg: m.msg, score: scoreOf(body), body };
				});
				// 通知也参与搜索（它们的正文很可能就是你在找的日志），编号用 notice#N
				const noticeHits: Hit[] = notices.map((x) => {
					const body = render({ role: "custom", customType: x.customType, content: x.content }, true).toLowerCase();
					return { label: `notice#${x.n}`, n: x.n, msg: x, score: scoreOf(body), body };
				});
				const hits = [...msgHits, ...noticeHits]
					.filter((h) => h.score > 0)
					.sort((a, b) => b.score - a.score || b.n - a.n);
				if (hits.length === 0) {
					return { content: [{ type: "text", text: `no matches for "${params.query}"` }], details: undefined };
				}
				const start = (page - 1) * PAGE;
				const pageHits = hits.slice(start, start + PAGE);
				const totalPages = Math.max(1, Math.ceil(hits.length / PAGE));
				const body = pageHits
					.map((h) =>
						h.label.startsWith("notice#")
							? `${h.label}  [${h.msg.customType}]\n${render({ role: "custom", customType: h.msg.customType, content: h.msg.content }, false).slice(0, 300)}`
							: `${h.label}  ${render(h.msg, false).slice(0, 300)}`,
					)
					.join("\n\n---\n\n");
				const more =
					page < totalPages
						? `\n\n--- ${hits.length} hits, page ${page}/${totalPages}: use page:${page + 1}, or ${pageHits[0].label.startsWith("notice#") ? `notices:[${pageHits[0].n}]` : `expand:[${pageHits[0].n}]`} for the full entry ---`
						: `\n\n--- ${hits.length} hits ---`;
				return { content: [{ type: "text", text: body + more }], details: undefined };
			}

			return asText("give one of: expand, range, query, notices, slice");
		},
	});
}
