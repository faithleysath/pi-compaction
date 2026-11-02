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

import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PAGE = 5;

/** 一次最多带回多少张图 —— 本机实测中位数一张 446 KB、p99 2.6 MB，不设上限能把上下文撑爆 */
const MAX_IMAGES = 6;
/** 单次照片总字节上限（base64 后），超了就停，避免一次 recall 把请求体顶到几十 MB */
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

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

/** 一条消息 → 纯文本（assistant 带 toolCall 名与参数，toolResult 带全文） */
const render = (msg: any, full: boolean): string => {
	const cap = full ? Infinity : 800;
	const cut = (s: string) => (s.length <= cap ? s : `${s.slice(0, cap)}…(+${s.length - cap})`);
	if (!msg) return "";
	if (msg.role === "excluded") return "（这条是 !! 命令，内容被排除在上下文之外，不提供）";
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
			"expand accepts several numbers at once (batch). Add image: true to get the real image blocks.",
			"#N is the number shown in summary headers like [user#12] / * read#12 / →#13. Only the current session is searchable.",
		].join("\n"),
		parameters: Type.Object({
			expand: Type.Optional(Type.Array(Type.Number(), { description: "Entry indices (#N, e.g. 12 for [user#12]) to return in full." })),
			range: Type.Optional(
				Type.Array(Type.Number(), { minItems: 2, maxItems: 2, description: "[from, to]: entries #from..#to inclusive." }),
			),
			query: Type.Optional(Type.String({ description: "Keywords to search for across the session." })),
			page: Type.Optional(Type.Number({ description: "Page number for range or query, 1-based. Default 1." })),
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
			const page = Math.max(1, Math.floor(params.page ?? 1));

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
						emit(`${label}: 有 ${imgs.length} 张图，但已达单次上限（${MAX_IMAGES} 张 / ${MAX_IMAGE_BYTES / 1024 / 1024} MB），未带回`);
						return;
					}
					emit(`${label}: 附图 ${take.length} 张${more > 0 ? `（另有 ${more} 张超出上限）` : ""}`);
					flush();
					for (const b of take) content.push({ type: "image", data: b.data, mimeType: b.mimeType });
				};

				const done = new Set<number>(); // 同一个编号只输出一次（批量里点了 #2 又点了 #3 时别重复）
				const show = (n: number, msg: any, heading: string) => {
					done.add(n);
					emit(`${heading}\n${render(msg, true)}`);
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
				if (wantImage && !sawImage) emit("（这些条目里没有图片）");
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
				const terms = params.query.toLowerCase().split(/\s+/).filter((t: string) => t.length > 1);
				const hits = msgs
					.map((m) => {
						const body = render(m.msg, false).toLowerCase();
						let score = 0;
						for (const t of terms) {
							const c = body.split(t).length - 1;
							if (c > 0) score += 1 + Math.log(c);
						}
						return { ...m, score, body };
					})
					.filter((h) => h.score > 0)
					.sort((a, b) => b.score - a.score || b.n - a.n);
				if (hits.length === 0) {
					return { content: [{ type: "text", text: `no matches for "${params.query}"` }], details: undefined };
				}
				const start = (page - 1) * PAGE;
				const pageHits = hits.slice(start, start + PAGE);
				const totalPages = Math.max(1, Math.ceil(hits.length / PAGE));
				const body = pageHits
					.map((h) => `#${h.n}  ${render(h.msg, false).slice(0, 300)}`)
					.join("\n\n---\n\n");
				const more =
					page < totalPages
						? `\n\n--- ${hits.length} hits, page ${page}/${totalPages}: use page:${page + 1}, or expand:[${pageHits[0].n}] for the full entry ---`
						: `\n\n--- ${hits.length} hits ---`;
				return { content: [{ type: "text", text: body + more }], details: undefined };
			}

			return { content: [{ type: "text", text: "give one of: expand, range, query" }], details: undefined };
		},
	});
}
