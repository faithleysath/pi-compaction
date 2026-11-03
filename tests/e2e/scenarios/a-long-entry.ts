/**
 * 场景 A · 链路正确性：单条 10 万字符条目 → 压缩 → expand 截断 → 按提示 slice → 逐字拼回
 *
 * 为什么用 codemode 造数据：pi 的 bash 工具结果会被截到 2000 行 / 50KB，
 * 单条 bash 结果永远到不了 60,000 字符，而 codemode 的 tools.bash 输出上限是 1 MiB。
 */
import { launch, makeSandbox } from "../env.ts";
import { Reporter } from "../report.ts";
import { numberEntries, render, text } from "../rpc.ts";
import type { RunContext, Scenario } from "./types.ts";

export const MARKER = "--- CONTENT START ---\n";
export const chunkOf = (t: string) => {
	const i = t.indexOf(MARKER);
	const j = t.lastIndexOf("\n--- CONTENT END ---");
	return i >= 0 && j > i ? t.slice(i + MARKER.length, j) : "";
};

/** 标记行的行号与内容是命令里现算的：模型既看不到行号也看不到值，只能真的去读 */
const CMD = [
	"seq 1 20000 > nums.txt",
	"P=$(( (RANDOM % 6000) + 13500 ))",
	"C=$(openssl rand -hex 4)",
	"awk -v p=$P -v c=CODE=$C 'NR==p{print c} {print}' nums.txt",
].join("\n");

async function run({ variant, model, stamp }: RunContext) {
	const rep = new Reporter();
	const box = makeSandbox("a", `${stamp}-${variant}`);
	const rpc = launch({ extDir: variant, work: box.work, sessions: box.sessions, scenario: "a", variant: "current", stamp, model });

	try {
		// 1. 造一条真实的长 toolResult
		await rpc.turn(
			[
				"用 codemode 工具执行下面这段脚本（原样执行，包括第一行的 options 注释），完成前不要做别的事：",
				"",
				"```js",
				'// @options: {"max_output_tokens": 40000}',
				`const r = await tools.bash({ command: ${JSON.stringify(CMD)} });`,
				"return r.output;",
				"```",
				"",
				"执行完后只回复一个词：done",
			].join("\n"),
		);

		const entries = await rpc.entries();
		const { msgs } = numberEntries(entries);
		const big = msgs.map((m) => ({ ...m, len: render(m.msg).length })).sort((a, b) => b.len - a.len)[0];
		const full = render(big.msg);
		const codeLine = full.split("\n").find((l) => /^CODE=[0-9a-f]{8}$/.test(l.trim()));
		const code = codeLine?.trim().slice("CODE=".length) ?? "";
		const at = full.indexOf(`CODE=${code}`);
		rep.metric("entry", { n: big.n, chars: big.len, codeAt: at });

		rep.check("真实会话里有单条 > 60,000 字符的条目", big.len > 60_000, big.len);
		rep.check("中段标记存在且落在 60k 之后", code.length === 8 && at > 60_000, { code, at });

		// 2. 压缩
		const ctxBefore = (await rpc.stats()).contextUsage;
		const comp = await rpc.compact();
		const summary = comp.result?.summary ?? "";
		rep.metric("compaction", { before: comp.result?.tokensBefore, after: comp.result?.estimatedTokensAfter, ctxBefore: ctxBefore?.tokens });
		rep.check("压缩走的是本插件（有 summary 且未 abort）", Boolean(summary) && !comp.aborted);
		rep.check("摘要里有那条长消息的 #N", new RegExp(`#${big.n}\\b`).test(summary), summary.slice(0, 160));
		rep.check("摘要里没有 CODE 值（只能靠 recall 取）", !summary.includes(code), code);

		// 3. 只说要什么，不说怎么做
		await rpc.turn(
			[
				"压缩前，有一次工具输出是 20000 行数字，其中随机某一行是 `CODE=xxxxxxxx`（8 位十六进制）。",
				"用 recall 工具把那次的原始输出读出来，找到这行，原样告诉我 CODE 的值。",
				"不要重新执行命令（重跑会得到另一个 CODE）。",
			].join("\n"),
		);

		const finalText = (await rpc.cmd({ type: "get_last_assistant_text" })).data?.text ?? "";
		rep.check("Agent 答对了 CODE（真的读到了原文）", code !== "" && finalText.includes(code), finalText.slice(0, 300));

		// 4. 核对它怎么读的
		const after = numberEntries(await rpc.entries());
		const all = collectCalls(after.msgs);
		const recall = all.filter((c) => c.name === "recall");
		const slices = recall.filter((c) => c.args?.slice);
		rep.metric("spontaneous", { tools: all.map((c) => c.name), sliceOffsets: slices.map((c) => Number(c.args.slice.offset ?? 0)) });
		rep.check("Agent 用了 recall", recall.length > 0, all.map((c) => c.name));
		rep.check(
			"自发路线的每个分块都与原文逐字对齐",
			slices.every((c) => {
				const off = Number(c.args.slice.offset ?? 0);
				const chunk = chunkOf(c.result);
				return !chunk || full.slice(off, off + chunk.length) === chunk;
			}),
		);

		// 5. 强制走一遍 expand → 提示 → next_offset 到底
		await rpc.turn(
			[
				`现在再走一遍固定流程，不要跳步：先用 recall 的 expand 取 #${big.n} 的完整原文；`,
				"如果返回说被截断了，就照着它给出的那条继续调用接着读，一直读到 has_more 为 false。",
				"读完之后回复一句「已读完」。",
			].join("\n"),
		);

		const all2 = collectCalls(numberEntries(await rpc.entries()).msgs);
		const phase2 = all2.slice(all.length);
		const expand = phase2.find((c) => c.name === "recall" && c.args?.expand);
		const hint = expand?.result.match(/"slice":\{"message":(\d+),"offset":(\d+)\}/);
		rep.metric("forced", { tools: phase2.map((c) => c.name), hint: hint?.[0] });
		rep.check("Agent 按指示用了 expand", Boolean(expand), phase2.map((c) => c.name));
		rep.check("expand 被 60k 截断并给出可执行 slice 提示", Boolean(hint), expand?.result.slice(-260));
		rep.check("提示里的编号是这条消息自己的 #N", hint ? Number(hint[1]) === big.n : false, hint?.[1]);

		if (hint) {
			const from = Number(hint[2]);
			const chain = phase2.filter((c) => c.args?.slice && Number(c.args.slice.message) === big.n);
			let cursor = from;
			let covered = "";
			let bad: unknown = null;
			for (const c of chain) {
				const off = Number(c.args.slice.offset ?? 0);
				if (off !== cursor) {
					bad = { expected: cursor, got: off };
					break;
				}
				covered += chunkOf(c.result);
				const next = c.result.match(/next_offset: (\d+|null)/);
				cursor = next && next[1] !== "null" ? Number(next[1]) : -1;
				if (cursor === -1) break;
			}
			rep.check("从提示给的 offset 起、每步都用 next_offset 衔接", bad === null && covered.length > 0, bad);
			rep.check("读到 has_more:false，拼起来等于原文剩余部分", covered === full.slice(from), {
				got: covered.length,
				want: full.slice(from).length,
			});
		}

		rep.metric("contextAfter", (await rpc.stats()).contextUsage?.tokens);
		return rep;
	} finally {
		rpc.close();
	}
}

type Call = { name: string; args: any; result: string };

function collectCalls(msgs: { n: number; msg: any }[]): Call[] {
	const out: Call[] = [];
	for (const m of msgs) {
		if (m.msg.role !== "assistant") continue;
		for (const p of Array.isArray(m.msg.content) ? m.msg.content : []) {
			if (p.type !== "toolCall") continue;
			const res = msgs.find((r) => r.msg.role === "toolResult" && r.msg.toolCallId === p.id);
			out.push({ name: p.name, args: p.arguments, result: res ? text(res.msg.content) : "" });
		}
	}
	return out;
}

export const scenario: Scenario = {
	id: "a",
	title: "超长单条 → 压缩 → expand 截断 → slice 逐字拼回",
	run,
};
