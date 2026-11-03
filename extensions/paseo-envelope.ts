/**
 * paseo 信封折叠。
 *
 * paseo 把「子代理完成通知 / 代理之间派活 / 定时触发」都写成一条 user 消息，外面套一层
 * XML 信封。实测这些信封占 paseo 会话 user 侧字符的 90%（通知 p50 1.9k 字符、
 * 派活 p50 1.0k），而信封头（uuid / message-id / server-id）对模型没有价值。
 *
 * 这里只处理**旧轮次**（上一轮摘要）。最新一轮永远保留全文，和工具折叠的策略一致：
 * 折叠掉的东西都能用 recall #N 取回，派活的完整任务书还能用 mcp__paseo__get_agent_activity 拉。
 *
 * 两种信封（形状见 paseo 的 agent/agent-messages/envelope.js）：
 *
 *   带版本号 —— agent 之间：
 *     <paseo-system version="1" kind="agent-message|agent-notification|user-message"
 *                   source-agent-id="…" message-id="…" [source-server-id="…"]
 *                   [source-agent-title="…"] [event="finished|errored|permission-required|closed"]>
 *     …正文…
 *     </paseo-system>
 *
 *   不带版本号 —— 定时触发（schedule / heartbeat 打到已有 agent）：
 *     <paseo-system>
 *     Schedule "名字" fired (id=…, run=…).
 *     …prompt…
 *     </paseo-system>
 *
 * 折叠产物是**非条目行**（不占 #N、不会被下一轮再认一次）：`[paseo] <标题> <动词> (#N)`。
 * 同一标题 / 同名 schedule 的多条会合并成 `×N (#a,#b,…)` —— 心跳一天几十次，不合并等于没折。
 * 合并是跨轮次的：上一轮已经折过的行这一轮会被重新分组，所以 96 条心跳最终只剩一行。
 */

/** 块边界。必须和 pi-compaction 里 collapseToolBlocks 的 NEW_BLOCK 保持一致 */
const BLOCK_START = /^(\[user(?=[#\]])|\[assistant(?=[#\]])|\* |→(?=[ #])|---\s*$)/;
const HEADER = /^\[user#(\d+)\]$/;
const VERSIONED_OPEN = /^<paseo-system((?:\s+[a-z-]+="[^"<>]*")+)>$/;
const BARE_OPEN = /^<paseo-system>$/;
const CLOSE_LINE = /^<\/paseo-system>$/;
/** 折叠行本身（下一轮要能认回来，才能跨轮次合并） */
const FOLD_MERGED = /^\[paseo\] (.+?) ×(\d+) \(([^)]*)\)$/;
const FOLD_SINGLE = /^\[paseo\] (.+?) (\(#\d+\))$/;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unxml = (s: string) => s.replace(/&(amp|lt|gt|quot|apos);/g, (_m, e) => ENTITIES[e] ?? e);

/** 属性顺序不固定，按名字取；值是 XML 转义过的（源码里 escapeXml 只转这 5 个实体） */
const attr = (attrs: string, name: string) => {
	const raw = attrs.match(new RegExp(`(?:^|\\s)${name}="([^"<>]*)"`))?.[1];
	return raw === undefined ? undefined : unxml(raw);
};

/** 合并时一行最多列几个编号，再多就 `…`（其余用 recall query 找） */
const MAX_IDS = 4;

const idsOf = (s: string) => (s.match(/#(\d+)/g) ?? []).map((x) => Number(x.slice(1)));

const splitBlocks = (text: string): string[][] => {
	const blocks: string[][] = [];
	let cur: string[] | null = null;
	for (const line of text.split("\n")) {
		if (BLOCK_START.test(line)) {
			if (cur) blocks.push(cur);
			cur = [line];
		} else if (cur) cur.push(line);
		else cur = [line];
	}
	if (cur) blocks.push(cur);
	return blocks;
};

const cleanTitle = (raw: string | undefined, max: number) => {
	const one = (raw ?? "").replace(/\s+/g, " ").trim();
	if (!one) return "";
	return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

/**
 * 认一个块是不是 paseo 信封。
 *
 * 三重条件，缺一不可 —— 否则用户随便贴一段讲 paseo 的文档也会被折掉：
 *   1. 块首是 `[user#N]`
 *   2. 正文第一行是完整信封开标签，最后一行是 `</paseo-system>`
 *   3. 带版本号那种必须有 version="1" + kind + message-id
 */
const parseEnvelope = (header: string, body: string[], maxTitle: number): string | null => {
	const num = header.match(HEADER)?.[1];
	if (num === undefined) return null;

	let end = body.length;
	while (end > 0 && body[end - 1].trim() === "") end--;
	if (end < 2) return null;
	const lines = body.slice(0, end).map((l) => l.trim());
	if (!CLOSE_LINE.test(lines[lines.length - 1])) return null;

	const open = lines[0];
	const versioned = open.match(VERSIONED_OPEN);
	if (versioned) {
		const attrs = versioned[1];
		if (attr(attrs, "version") !== "1") return null;
		const kind = attr(attrs, "kind");
		if (!kind || !attr(attrs, "message-id")) return null;
		// 一次投递里合并了多个信封：只认第一个，标一下数量
		const batch = lines.filter((l) => VERSIONED_OPEN.test(l)).length;
		const more = batch > 1 ? ` (+${batch - 1} more)` : "";
		const title = cleanTitle(attr(attrs, "source-agent-title"), maxTitle);
		const id = (attr(attrs, "source-agent-id") ?? "").slice(0, 8);
		const who = title || id || "agent";
		if (kind === "agent-notification") {
			const event = attr(attrs, "event");
			return `[paseo] ${who} notify${event ? `:${event}` : ""}${more} (#${num})`;
		}
		if (kind === "agent-message") return `[paseo] ${who} from${more} (#${num})`;
		if (kind === "user-message") return `[paseo] quoted${more} (#${num})`;
		// 未知 kind：可能是 paseo 以后加的，别乱折
		return null;
	}

	if (BARE_OPEN.test(open)) {
		const first = lines[1] ?? "";
		const named = first.match(/^Schedule "(.+?)" fired/);
		if (named) return `[paseo] schedule "${named[1].replace(/"/g, "'")}" fired (#${num})`;
		if (/^Schedule fired/.test(first)) return `[paseo] schedule fired (#${num})`;
		return null;
	}

	return null;
};

type Group = { idx: number; label: string; count: number; nums: number[] };

/** 把已经折过的行认回来：跨轮次合并靠它，不然 96 条心跳就是 96 行 */
const parseFoldedLine = (line: string): { label: string; count: number; nums: number[] } | null => {
	const merged = line.match(FOLD_MERGED);
	if (merged) return { label: merged[1], count: Number(merged[2]), nums: idsOf(merged[3]) };
	const single = line.match(FOLD_SINGLE);
	if (single) return { label: single[1], count: 1, nums: idsOf(single[2]) };
	return null;
};

const renderFold = (label: string, count: number, nums: number[]) => {
	if (count <= 1) return `[paseo] ${label} (${nums.map((n) => `#${n}`).join(",")})`;
	const shown = nums.slice(0, MAX_IDS).map((n) => `#${n}`).join(",");
	// count 比列出来的多，就说明还有没列出的编号；这个判断让重复折叠结果稳定
	const more = count > Math.min(nums.length, MAX_IDS) ? ",…" : "";
	return `[paseo] ${label} ×${count} (${shown}${more})`;
};

/**
 * 折叠旧轮次摘要里的 paseo 信封。
 *
 * 两步：先把信封块换成一行，再在整段文本上按标签合并（包括上一轮已经折过的行）。
 *
 * 幂等：再来一遍时，`[user#` 开头的块已经没有了；折过的行会被 parseFoldedLine 认回来、
 * 重新渲染成同样的文本（`×N` 的 N 从行里读，不会越合越少）。
 */
export const collapsePaseo = (text: string, opts: { merge?: boolean; maxTitle?: number } = {}): string => {
	const maxTitle = opts.maxTitle ?? 80;
	const merge = opts.merge !== false;

	const folded = splitBlocks(text)
		.map((block) => {
			const line = parseEnvelope(block[0] ?? "", block.slice(1), maxTitle);
			return line ?? block.join("\n").replace(/\n+$/, "");
		})
		.join("\n\n");
	if (!merge) return folded.replace(/\n{3,}/g, "\n\n").trim();

	const lines = folded.split("\n");
	const keep: (string | null)[] = lines.slice();
	const groups = new Map<string, Group>();
	for (let i = 0; i < lines.length; i++) {
		if (!lines[i].startsWith("[paseo] ")) continue;
		const parsed = parseFoldedLine(lines[i]);
		if (!parsed) continue;
		const g = groups.get(parsed.label);
		if (!g) {
			groups.set(parsed.label, { idx: i, label: parsed.label, count: parsed.count, nums: parsed.nums });
			continue;
		}
		// 编号 append-only，同一编号不会重复；重复调用时这道判断防止把同一行算两次
		for (const n of parsed.nums) if (!g.nums.includes(n)) g.nums.push(n);
		g.count += parsed.count;
		keep[i] = null; // 合并掉的行整行删掉
	}
	for (const g of groups.values()) keep[g.idx] = renderFold(g.label, g.count, g.nums);

	return keep
		.filter((l): l is string => l !== null)
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
};
