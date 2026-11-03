/**
 * pi-compaction benchmark。
 *
 *   bun run bench
 *
 * 用真实 handler 跑固定的合成会话，不经过 pi 进程。两组 workload：
 *
 *   短轮次：1 轮 = 1 条用户消息 + 3 次工具调用。压 6 轮，看摘要怎么长。
 *   完整周期：1 轮 = 55 个 turn（每个 turn 1 次工具调用），接近真实会话
 *            两次压缩之间的量。压 2 轮拿到每轮增量，再外推 1M 窗口能压多少次。
 *
 * 配置隔离：把 PI_CODING_AGENT_DIR 指到临时目录，bench 不会碰你真实的
 * ~/.pi/agent/pi-compaction.json。必须在 import 扩展之前设置。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-compaction-bench-"));
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;

const ext = (await import("../extensions/pi-compaction.ts")).default;

/** 1M 窗口、pi 默认 reserve / keep */
const WINDOW_TOKENS = 1_000_000;
const RESERVE_TOKENS = 16_384;
const KEEP_RECENT_TOKENS = 20_000;
/** pi 的 token 估算大约 4 字符 / token；bench 只比较相对大小 */
const CHARS_PER_TOKEN = 4;
/** 每段用户/助手正文的长度 */
const TEXT_CHARS = 80;

type Entry = any;

const handlers: Record<string, Function> = {};
const pi: any = {
	on: (name: string, fn: Function) => {
		handlers[name] = fn;
		return () => {};
	},
};
ext(pi);
const compact = handlers["session_before_compact"];
if (!compact) throw new Error("session_before_compact 未注册");

const link = (entries: Entry[]): Entry[] => {
	for (let i = 1; i < entries.length; i++) entries[i].parentId = entries[i - 1].id;
	return entries;
};

const msg = (id: string, role: string, content: any, extra: any = {}): Entry => ({
	id,
	type: "message",
	message: { role, content, ...extra },
});

/** 固定长度、可复现的正文，避免随机数导致每次跑出来的数不一样 */
const fill = (seed: string, n: number) => {
	let s = "";
	while (s.length < n) s += seed;
	return s.slice(0, n);
};

const userText = (tag: string) => `需求 ${tag}：` + fill("修一下 auth，reset 之后 refresh token 没更新。", TEXT_CHARS);
const asstText = (tag: string) => `分析 ${tag}：` + fill("确认 rotateRefreshToken 的调用点，再补一个用例。", TEXT_CHARS);
const asstTail = (tag: string) => `完成 ${tag}：` + fill("用例已补，测试通过。", TEXT_CHARS);
const bashCommand = (tag: string) =>
	`rg rotateRefreshToken -n src/ --glob '!node_modules' --context 3 --hidden ${tag} ` + fill("--exclude=dist ", 240);
const readArgs = (i: number) => ({ path: "src/auth/session.ts", offset: 1 + i, limit: 2000 });
const resultText = (tag: string, i: number) =>
	`src/auth/session.ts:${40 + i}  rotateRefreshToken(token)\n` +
	fill("// 一大段工具输出，包含调用栈、diff、行号、错误信息。", 2_900) +
	`\nEXIT_CODE_${i}`;
const THINKING = fill("THINKING_SHOULD_BE_DROPPED ", 500);

/** 一个 turn：用户消息 → 助手正文 + N 个工具调用 → N 个结果 → 助手收尾 */
function turn(round: number, t: number, toolsPerTurn: number): Entry[] {
	const tag = `r${round}t${t}`;
	const out: Entry[] = [msg(`u${tag}`, "user", [{ type: "text", text: userText(tag) }])];
	const content: any[] = [
		{ type: "thinking", thinking: THINKING },
		{ type: "text", text: asstText(tag) },
	];
	for (let i = 0; i < toolsPerTurn; i++) {
		const kind = (i + t) % 2 === 0 ? "bash" : "read";
		content.push({
			type: "toolCall",
			id: `tc${tag}_${i}`,
			name: kind,
			arguments: kind === "bash" ? { command: bashCommand(tag) } : readArgs(i),
		});
	}
	out.push(msg(`a${tag}`, "assistant", content));
	for (let i = 0; i < toolsPerTurn; i++) {
		const kind = (i + t) % 2 === 0 ? "bash" : "read";
		out.push(msg(`r${tag}_${i}`, "toolResult", [{ type: "text", text: resultText(tag, i) }], {
			toolName: kind,
			toolCallId: `tc${tag}_${i}`,
		}));
	}
	out.push(msg(`af${tag}`, "assistant", [{ type: "text", text: asstTail(tag) }]));
	return out;
}

/** 一轮 = turns 个 turn，拼成一条 parentId 链 */
function round(r: number, turns: number, toolsPerTurn: number): Entry[] {
	return Array.from({ length: turns }, (_, t) => turn(r, t, toolsPerTurn)).flat();
}

/* ── paseo workload：user 侧 90% 是信封 ─────────────── */

/** 子代理标题固定，所以「同一子代理又一次完成」能测到合并 ×N */
const PASEO_AGENTS = ["逆向-头部分析", "逆向-尾段定位", "博文维护"];
const PASEO_BODY_CHARS = 1_500;
const PASEO_TOOL_RESULT = `<paseo-system version="1" kind="user-message" message-id="x">${" "}</paseo-system>`.slice(0, 306);

const envelopeNotif = (round: number, agent: number) => {
	const title = PASEO_AGENTS[agent % PASEO_AGENTS.length];
	// id 按「子代理」固定、不随轮次变：同一个子代理反复完成才会合并成 ×N（心跳就是这个形状）
	const id = `agent${agent}`.padStart(8, "0");
	const body = `第 ${round} 轮结论：` + fill("把这一段的常量表抠出来，按位域重排后验证。", PASEO_BODY_CHARS);
	return [
		`<paseo-system version="1" kind="agent-notification" source-agent-id="${id}-4ac2-88b5-fcb0b49067fc" message-id="m-${round}-${agent}" source-server-id="srv_local" source-agent-title="${title}" event="finished">`,
		`Agent ${id} (${title}) finished.`,
		"",
		"&lt;agent-response&gt;",
		body,
		"&lt;/agent-response&gt;",
		"</paseo-system>",
	].join("\n");
};

const envelopeSend = (round: number) =>
	[
		"<paseo-system version=\"1\" kind=\"agent-message\" source-agent-id=\"parent01-4ac2\" message-id=\"m-send-" + round + "\" source-agent-title=\"总协调\">",
		"继续盯这一头，" + fill("把新的实测结果写进报告。", 300),
		"</paseo-system>",
	].join("\n");

/** 一个 turn：3 条子代理通知（user 消息）+ 1 条父代理派活回显 + 1 次 MCP 调用 + 助手正文 */
function paseoTurn(r: number, t: number): Entry[] {
	const tag = `r${r}t${t}`;
	const out: Entry[] = [];
	for (let a = 0; a < PASEO_AGENTS.length; a++) {
		out.push(msg(`u${tag}n${a}`, "user", [{ type: "text", text: envelopeNotif(r, a) }]));
	}
	out.push(msg(`u${tag}s`, "user", [{ type: "text", text: envelopeSend(r) }]));
	out.push(
		msg(`a${tag}`, "assistant", [
			{ type: "text", text: asstText(tag) },
			{
				type: "toolCall",
				id: `tc${tag}`,
				name: "mcp__paseo__send_agent_prompt",
				arguments: { agentId: `agent-${r}-${t}`, prompt: "继续", notifyOnFinish: true },
			},
		]),
	);
	out.push(msg(`r${tag}`, "toolResult", [{ type: "text", text: PASEO_TOOL_RESULT }], { toolName: "mcp__paseo__send_agent_prompt", toolCallId: `tc${tag}` }));
	out.push(msg(`af${tag}`, "assistant", [{ type: "text", text: asstTail(tag) }]));
	return out;
}

const paseoRound = (r: number, turns: number) => Array.from({ length: turns }, (_, t) => paseoTurn(r, t)).flat();

function writeConfig(collapseOldTools: boolean, paseoCollapse = true) {
	writeFileSync(
		join(AGENT_DIR, "pi-compaction.json"),
		JSON.stringify({ toolArgs: 300, toolResultHead: 200, toolResultTail: 100, collapseOldTools, paseo: { collapseEnvelopes: paseoCollapse } }, null, 2),
	);
}

function runRound(entries: Entry[], cutId: string, previousSummary: string | undefined, allEntries: Entry[] = entries): string {
	const event: any = {
		type: "session_before_compact",
		branchEntries: entries,
		preparation: {
			firstKeptEntryId: cutId,
			tokensBefore: 0,
			previousSummary,
			settings: { enabled: true, reserveTokens: RESERVE_TOKENS, keepRecentTokens: KEEP_RECENT_TOKENS },
		},
		reason: "manual",
		willRetry: false,
	};
	const ctx: any = {
		hasUI: false,
		ui: { notify: () => {} },
		model: { contextWindow: WINDOW_TOKENS },
		sessionManager: { getEntries: () => allEntries },
	};
	const res: any = compact(event, ctx);
	const summary = res?.compaction?.summary;
	if (typeof summary !== "string") throw new Error("没有返回 compaction.summary");
	return summary;
}

type Row = { round: number; chars: number; markers: number; folds: number };

/**
 * 跑 rounds 轮压缩。每轮只把上一轮放进窗口（更早的在上一次的摘要里），
 * 切点放在下一轮的哨兵消息上，于是本轮正文 = 一个完整轮次。
 */
function measure(
	collapseOldTools: boolean,
	rounds: number,
	turns: number,
	toolsPerTurn: number,
	makeRound: (r: number, turns: number) => Entry[] = (r, t) => round(r, t, toolsPerTurn),
	paseoCollapse = true,
): Row[] {
	writeConfig(collapseOldTools, paseoCollapse);
	const rows: Row[] = [];
	let previousSummary: string | undefined;
	const allEntries: Entry[] = [];
	for (let r = 1; r <= rounds; r++) {
		const body = makeRound(r - 1, turns);
		const sentinel = msg(`cut${r}`, "user", [{ type: "text", text: "下一轮" }]);
		// 编号按整个 session 数：前面轮次还在 session 文件里，只是不在当前分支上
		allEntries.push(...body, sentinel);
		const entries = link([...body, sentinel]);
		const summary = runRound(entries, sentinel.id, previousSummary, allEntries);
		previousSummary = summary;
		rows.push({
			round: r,
			chars: summary.length,
			markers: (summary.match(/\(collapsed /g) ?? []).length,
			folds: (summary.match(/^\[paseo\] /gm) ?? []).length,
		});
	}
	return rows;
}

const pct = (a: number, b: number) => `${((1 - b / a) * 100).toFixed(1)}%`;
const n = (x: number) => x.toLocaleString("en-US");
const budgetChars = (WINDOW_TOKENS - RESERVE_TOKENS - KEEP_RECENT_TOKENS) * CHARS_PER_TOKEN;

/* ── 短轮次：6 轮压缩的摘要大小 ─────────────────────── */

const SHORT_TURNS = 1;
const SHORT_TOOLS = 3;
const SHORT_ROUNDS = 6;

const short = [false, true].map((collapseOldTools) => ({
	collapseOldTools,
	rows: measure(collapseOldTools, SHORT_ROUNDS, SHORT_TURNS, SHORT_TOOLS),
}));

console.log(`# pi-compaction benchmark\n`);
console.log(`合成会话（固定内容、无随机数），工具参数截断 300、结果头 200 / 尾 100。`);
console.log(`切点固定在下一轮开头，本轮正文 = 一个完整轮次。\n`);

console.log(`## 短轮次：1 轮 = 1 个 turn（3 次工具调用），压 ${SHORT_ROUNDS} 轮\n`);
console.log("| 轮次 | collapseOldTools=false | true | 折叠掉 |");
console.log("|---|---|---|---|");
for (let i = 0; i < SHORT_ROUNDS; i++) {
	const a = short[0].rows[i];
	const b = short[1].rows[i];
	console.log(`| ${i + 1} | ${n(a.chars)} | ${n(b.chars)} | ${pct(a.chars, b.chars)} |`);
}
const shortLast = short.map((r) => r.rows[r.rows.length - 1]);
console.log(
	`\n${SHORT_ROUNDS} 轮后：${n(shortLast[0].chars)} → ${n(shortLast[1].chars)} 字符，折叠掉 ${pct(shortLast[0].chars, shortLast[1].chars)}。\n`,
);

/* ── 完整周期：接近真实两次压缩之间的量，外推 1M 窗口 ── */

const CYCLE_TURNS = 55;
const CYCLE_TOOLS = 1;
const CYCLE_ROUNDS = 2; // 第 1 轮拿基数，第 2 轮拿增量

const cycle = [false, true].map((collapseOldTools) => ({
	collapseOldTools,
	rows: measure(collapseOldTools, CYCLE_ROUNDS, CYCLE_TURNS, CYCLE_TOOLS),
}));

type Head = { growth: number; compactions: number; turns: number };
function headroom(rows: Row[]): Head {
	const growth = rows[rows.length - 1].chars - rows[rows.length - 2].chars;
	const compactions = Math.floor((budgetChars - rows[0].chars) / growth) + 1;
	return { growth, compactions, turns: compactions * CYCLE_TURNS };
}
const cycleHeads = cycle.map((c) => headroom(c.rows));

/* ── paseo：user 侧 90% 是信封（子代理通知 / 派活回显） ── */

const PASEO_ROUNDS = 4;
const paseo = [false, true].map((collapseEnvelopes) => ({
	collapseEnvelopes,
	rows: measure(true, PASEO_ROUNDS, 1, 0, paseoRound, collapseEnvelopes),
}));

console.log(`## paseo workload：1 轮 = ${PASEO_AGENTS.length} 条子代理通知 + 1 条派活回显 + 1 次 MCP 调用\n`);
console.log("| 轮次 | 不折信封 | 折信封 | 折叠行数 |");
console.log("|---|---|---|---|");
for (let i = 0; i < PASEO_ROUNDS; i++) {
	const a = paseo[0].rows[i];
	const b = paseo[1].rows[i];
	console.log(`| ${i + 1} | ${n(a.chars)} | ${n(b.chars)} | ${b.folds} |`);
}
const paseoLast = paseo.map((x) => x.rows[x.rows.length - 1]);
console.log(
	`\n${PASEO_ROUNDS} 轮后：${n(paseoLast[0].chars)} → ${n(paseoLast[1].chars)} 字符，省 ${pct(paseoLast[0].chars, paseoLast[1].chars)}。\n`,
);

const report = {
	windowTokens: WINDOW_TOKENS,
	reserveTokens: RESERVE_TOKENS,
	keepRecentTokens: KEEP_RECENT_TOKENS,
	short: { turnsPerRound: SHORT_TURNS, toolsPerTurn: SHORT_TOOLS, rounds: SHORT_ROUNDS, results: short },
	cycle: {
		turnsPerRound: CYCLE_TURNS,
		toolsPerTurn: CYCLE_TOOLS,
		rounds: CYCLE_ROUNDS,
		results: cycle,
		growthPerRound: cycleHeads.map((h) => h.growth),
		compactions: cycleHeads.map((h) => h.compactions),
		turns: cycleHeads.map((h) => h.turns),
	},
	paseo: {
		notificationsPerRound: PASEO_AGENTS.length,
		envelopeBodyChars: PASEO_BODY_CHARS,
		rounds: PASEO_ROUNDS,
		results: paseo,
	},
};

console.log(`## 完整周期：1 轮 = ${CYCLE_TURNS} 个 turn（每 turn 1 次工具调用）\n`);
console.log(`摘要预算：(${n(WINDOW_TOKENS)} - ${n(RESERVE_TOKENS)} - ${n(KEEP_RECENT_TOKENS)}) × ${CHARS_PER_TOKEN} = ${n(budgetChars)} 字符。`);
console.log(`每轮增量取实测的第 1→2 轮差值；压缩次数是外推，不是实际跑满 1M 窗口。\n`);
console.log("| collapseOldTools | 1 轮后 | 2 轮后 | 每轮增量（字符） | 压缩次数 | 对话 turn 数 |");
console.log("|---|---|---|---|---|---|");
for (let i = 0; i < cycle.length; i++) {
	console.log(
		`| ${cycle[i].collapseOldTools} | ${n(cycle[i].rows[0].chars)} | ${n(cycle[i].rows[1].chars)} | ${n(cycleHeads[i].growth)} | ${n(cycleHeads[i].compactions)} | ${n(cycleHeads[i].turns)} |`,
	);
}
console.log(`\n倍数：${(cycleHeads[1].compactions / cycleHeads[0].compactions).toFixed(1)}×（折叠后能多压几次）。\n`);

/* 机器可读的输出，方便以后做回归 */
const reportText = `${JSON.stringify(report, null, 2)}\n`;
console.log("<!-- bench-json");
console.log(reportText.trimEnd());
console.log("bench-json -->");

rmSync(AGENT_DIR, { recursive: true, force: true });

const args = process.argv.slice(2);
const baselinePath = fileURLToPath(new URL("./results.json", import.meta.url));
if (args.includes("--write")) {
	writeFileSync(baselinePath, reportText);
	console.log(`\n已写入 ${baselinePath}`);
} else if (args.includes("--check")) {
	if (!existsSync(baselinePath)) {
		console.error("\n缺少 bench/results.json；先跑 bun run bench --write");
		process.exitCode = 1;
	} else if (readFileSync(baselinePath, "utf8") !== reportText) {
		console.error("\n结果和 bench/results.json 不一致。改了格式说明 / 截断 / 折叠后，先跑 `bun run bench --write` 更新基线，再同步 README 和 bench/README.md。");
		process.exitCode = 1;
	} else {
		console.log("\nbenchmark 和基线一致。");
	}
}
