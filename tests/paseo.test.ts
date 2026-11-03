/**
 * paseo 信封折叠测试。
 *   bun run tests/paseo.test.ts
 *
 * 两半：纯函数（collapsePaseo 的识别 / 转义 / 合并 / 幂等）+ 一次真实 handler 集成，
 * 确认「只有旧轮次被折、最新一轮保真、格式说明按需追加」。
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 配置隔离：必须在 import 扩展之前指到临时目录，否则会读你真实的 ~/.pi/agent/pi-compaction.json
const AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-compaction-paseo-"));
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
writeFileSync(join(AGENT_DIR, "pi-compaction.json"), JSON.stringify({}));

const { collapsePaseo } = await import("../extensions/paseo-envelope.ts");
const ext = (await import("../extensions/pi-compaction.ts")).default;

const handlers: Record<string, Function> = {};
ext({ on: (name: string, fn: Function) => { handlers[name] = fn; } } as any);
const compact = handlers["session_before_compact"];

let pass = 0,
	fail = 0;
function check(name: string, cond: boolean, info?: any) {
	if (cond) {
		pass++;
		console.log(`  ok   ${name}`);
	} else {
		fail++;
		console.log(`  FAIL ${name}`, info === undefined ? "" : JSON.stringify(info).slice(0, 300));
	}
}

/** paseo 的 formatAgentMessage 产出的形状（属性顺序固定，但解析不该依赖它） */
const envNotif = (title: string, event: string, body: string) =>
	[
		`<paseo-system version="1" kind="agent-notification" source-agent-id="4e48b6ee-f781-4ac2-88b5-fcb0b49067fc" message-id="83eaa74a-56c" source-server-id="srv_x" source-agent-title="${title}" event="${event}">`,
		`Agent 4e48b6ee (${title}) ${event}.`,
		"",
		"&lt;agent-response&gt;",
		body,
		"&lt;/agent-response&gt;",
		"</paseo-system>",
	].join("\n");

const notif = (num: number, title: string, event: string, body: string) => `[user#${num}]\n${envNotif(title, event, body)}`;

const FORMAT_PREFIX = "Format: a line starting with [user#N]";

const agentMsg = (num: number, title: string, body: string) =>
	[
		`[user#${num}]`,
		`<paseo-system version="1" kind="agent-message" source-agent-id="a0556ca7-e2d8" message-id="1c72edf5" source-agent-title="${title}">`,
		body,
		"</paseo-system>",
	].join("\n");

const schedule = (num: number, name: string) =>
	[
		`[user#${num}]`,
		"<paseo-system>",
		`Schedule "${name}" fired (id=966f7480, run=42c66321).`,
		"做协调巡检，不要自己钻细节。",
		"</paseo-system>",
	].join("\n");

console.log("[1] 识别四种信封");
{
	const out = collapsePaseo(notif(236, "VM-1 位域", "finished", "我先复现已知 9 组配方".repeat(40)));
	check("折成一行", out.split("\n").length === 1, out);
	check("保留标题和 event", out.includes("VM-1 位域 notify:finished"), out);
	check("保留编号", out.includes("(#236)"));
	check("正文没进摘要", !out.includes("我先复现已知 9 组配方"), out);

	const m = collapsePaseo(agentMsg(12, "Magpie Phase 10", "你是本任务的子代理。".repeat(50)));
	check("agent-message 折成 from", m === "[paseo] Magpie Phase 10 from (#12)", m);

	const s = collapsePaseo(schedule(301, "六神协调巡检"));
	check("裸信封折成 schedule", s === '[paseo] schedule "六神协调巡检" fired (#301)', s);

	const quoted = collapsePaseo(
		['[user#88]', '<paseo-system version="1" kind="user-message" message-id="x">', "hi", "</paseo-system>"].join("\n"),
	);
	check("user-message 折成 quoted", quoted === "[paseo] quoted (#88)", quoted);
}

console.log("\n[2] 别乱折");
{
	const doc = [
		"[user#5]",
		"paseo 的信封长这样：",
		'<paseo-system version="1" kind="agent-message" ...>',
		"</paseo-system>",
	].join("\n");
	check("提到信封的普通文本不动", collapsePaseo(doc) === doc, collapsePaseo(doc));

	const unknown = [
		"[user#6]",
		'<paseo-system version="1" kind="something-new" message-id="m">',
		"x",
		"</paseo-system>",
	].join("\n");
	check("未知 kind 不动", collapsePaseo(unknown) === unknown);

	const noClose = ["[user#7]", '<paseo-system version="1" kind="agent-message" message-id="m">', "x"].join("\n");
	check("少了闭合标签不动", collapsePaseo(noClose) === noClose, collapsePaseo(noClose));

	const noVersion = ["[user#8]", '<paseo-system version="2" kind="agent-message" message-id="m">', "x", "</paseo-system>"].join("\n");
	check("version 不是 1 不动", collapsePaseo(noVersion) === noVersion);

	const asst = ['[assistant#9]', '<paseo-system version="1" kind="agent-message" message-id="m">', "x", "</paseo-system>"].join("\n");
	check("assistant 块不动", collapsePaseo(asst) === asst);

	const bareUnknown = ["[user#10]", "<paseo-system>", "别的裸信封", "</paseo-system>"].join("\n");
	check("不认识的裸信封不动", collapsePaseo(bareUnknown) === bareUnknown);
}

console.log("\n[3] 属性解析");
{
	const reordered = [
		"[user#20]",
		'<paseo-system event="errored" source-agent-title="A &amp; B &quot;x&quot;" kind="agent-notification" message-id="m" version="1" source-agent-id="deadbeef-1">',
		"x",
		"</paseo-system>",
	].join("\n");
	check("属性顺序无关 + XML 实体还原", collapsePaseo(reordered).includes('A & B "x" notify:errored'), collapsePaseo(reordered));

	const noTitle = [
		"[user#21]",
		'<paseo-system version="1" kind="agent-notification" source-agent-id="0649088c-4615" message-id="m" event="closed">',
		"x",
		"</paseo-system>",
	].join("\n");
	check("没有标题时退回短 id", collapsePaseo(noTitle).includes("0649088c notify:closed"), collapsePaseo(noTitle));

	const long = notif(22, "长".repeat(200), "finished", "x");
	const folded = collapsePaseo(long);
	check("标题被截到 80 字符以内", folded.length < 120, folded.length);

	const batch = [
		"[user#23]",
		'<paseo-system version="1" kind="agent-message" source-agent-id="a1" message-id="m1">',
		"第一条",
		"</paseo-system>",
		"",
		'<paseo-system version="1" kind="agent-message" source-agent-id="a2" message-id="m2">',
		"第二条",
		"</paseo-system>",
	].join("\n");
	check("一批多个信封标出数量", collapsePaseo(batch).includes("(+1 more)"), collapsePaseo(batch));
}

console.log("\n[4] 合并重复");
{
	const text = [
		notif(280, "博文维护", "finished", "第一轮"),
		"",
		"[assistant#281]",
		"收到",
		"",
		notif(445, "博文维护", "finished", "第二轮"),
		"",
		notif(446, "别的活", "errored", "挂了"),
	].join("\n");
	const out = collapsePaseo(text);
	check("同标签合并成 ×2", out.includes("[paseo] 博文维护 notify:finished ×2 (#280,#445)"), out);
	check("不同标签不合并", out.includes("[paseo] 别的活 notify:errored (#446)"), out);
	check("合并后只有两行 paseo", (out.match(/^\[paseo\] /gm) ?? []).length === 2, out);

	const noMerge = collapsePaseo(text, { merge: false });
	check("merge:false 时分开列", (noMerge.match(/^\[paseo\] /gm) ?? []).length === 3, noMerge);

	const many = Array.from({ length: 7 }, (_, i) => notif(100 + i, "巡检", "finished", "x")).join("\n\n");
	const capped = collapsePaseo(many);
	check("编号最多列 4 个再省略", capped.includes("×7 (#100,#101,#102,#103,…)"), capped);

	check("幂等：折两遍结果一样", collapsePaseo(capped) === capped, collapsePaseo(capped));

	// 心跳场景：每次触发是单独一轮，上一轮折过的行必须能被认回来继续合并
	const r1 = collapsePaseo(notif(1, "协调巡检", "finished", "第一轮"));
	const r2 = collapsePaseo(`${r1}\n\n${notif(9, "协调巡检", "finished", "第二轮")}`);
	check("跨轮次也合并成 ×2", r2 === "[paseo] 协调巡检 notify:finished ×2 (#1,#9)", r2);
	check("跨轮次合并幂等", collapsePaseo(r2) === r2, collapsePaseo(r2));
	const r3 = collapsePaseo(`${r2}\n\n${notif(20, "协调巡检", "errored", "第三轮")}`);
	check("event 不同不合并", r3.split("\n").filter((l) => l.startsWith("[paseo] ")).length === 2, r3);
}

console.log("\n[5] 只有旧轮次被折，最新一轮保真");
{
	const link = (entries: any[]) => {
		for (let i = 1; i < entries.length; i++) entries[i].parentId = entries[i - 1].id;
		return entries;
	};
	const entries = link([
		{ id: "sys", type: "message", message: { role: "system", content: "" } },
		{ id: "u1", type: "message", message: { role: "user", content: [{ type: "text", text: "干活" }] } },
		{ id: "a1", type: "message", message: { role: "assistant", content: [{ type: "text", text: "好" }] } },
		{
			id: "u2",
			type: "message",
			message: { role: "user", content: [{ type: "text", text: envNotif("当前轮子代理", "finished", "当前轮的完整报告内容") }] },
		},
		{ id: "u3", type: "message", message: { role: "user", content: [{ type: "text", text: "下一轮" }] } },
	]);
	const prev = ["Format: x", "", notif(1, "旧轮子代理", "finished", "旧轮次的长报告".repeat(200))].join("\n");
	const event: any = {
		type: "session_before_compact",
		branchEntries: entries,
		preparation: { firstKeptEntryId: "u3", tokensBefore: 1, previousSummary: prev, settings: { enabled: true } },
		reason: "manual",
		willRetry: false,
	};
	const ctx: any = { hasUI: false, ui: { notify: () => {} }, sessionManager: { getEntries: () => entries } };
	const summary: string = (compact(event, ctx) as any)?.compaction?.summary ?? "";

	check("旧轮次折了", summary.includes("[paseo] 旧轮子代理 notify:finished (#1)"), summary.slice(0, 400));
	check("旧轮次正文没进摘要", !summary.includes("旧轮次的长报告"), summary.length);
	check("最新一轮没折", summary.includes("<paseo-system version=\"1\""), summary.slice(-600));
	check("最新一轮正文在", summary.includes("当前轮的完整报告内容"), summary.slice(-600));
	check("格式说明追加了 paseo 那句", summary.startsWith("Format:") && summary.includes("[paseo] <title> <verb> (#N)"), summary.slice(0, 300));
	check("尾注只有一份", (summary.match(/Fetch the original text of any #N/g) ?? []).length === 1);
}

console.log("\n[6] 没有 paseo 行时不加那句说明");
{
	const link = (entries: any[]) => {
		for (let i = 1; i < entries.length; i++) entries[i].parentId = entries[i - 1].id;
		return entries;
	};
	const entries = link([
		{ id: "u1", type: "message", message: { role: "user", content: [{ type: "text", text: "a" }] } },
		{ id: "u2", type: "message", message: { role: "user", content: [{ type: "text", text: "b" }] } },
	]);
	const event: any = {
		type: "session_before_compact",
		branchEntries: entries,
		preparation: { firstKeptEntryId: "u2", tokensBefore: 1, settings: { enabled: true } },
		reason: "manual",
		willRetry: false,
	};
	const ctx: any = { hasUI: false, ui: { notify: () => {} }, sessionManager: { getEntries: () => entries } };
	const summary: string = (compact(event, ctx) as any)?.compaction?.summary ?? "";
	check("没有 paseo 说明", !summary.includes("[paseo] <title>"), summary.slice(0, 300));
	check("格式说明仍是基础那句", summary.startsWith(FORMAT_PREFIX));
}


console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
