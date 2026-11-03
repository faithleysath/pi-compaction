/**
 * 场景 B · 扩展通知：pi-bg-bash 完成通知 → query 找到 notice#N → notices 取全文 → slice.notice 分块读完
 *
 * 通知不占 #N（编号空间必须和 compaction 一致），只能走 notice#N 那一套。
 */
import { bgBashExtension, launch, makeSandbox } from "../env.ts";
import { Reporter } from "../report.ts";
import { numberEntries, render, text } from "../rpc.ts";
import type { RunContext, Scenario } from "./types.ts";

const MARKER = "--- CONTENT START ---\n";
const chunkOf = (t: string) => {
	const i = t.indexOf(MARKER);
	const j = t.lastIndexOf("\n--- CONTENT END ---");
	return i >= 0 && j > i ? t.slice(i + MARKER.length, j) : "";
};

// 长行让 completion 的尾巴（最后 20 行 / 4 KiB）本身就够长，逼出多块 slice
const BG_CMD =
	"for i in $(seq 1 400); do printf '%04d %s\\n' $i \"$(printf 'x%.0s' {1..200})\"; done; echo NOTICE_MARKER=$(openssl rand -hex 4)";

async function run({ variant, model, stamp }: RunContext) {
	const rep = new Reporter();
	const box = makeSandbox("b", `${stamp}-current`);
	const bg = bgBashExtension();
	if (!bg) {
		rep.check("pi-bg-bash 已安装（否则跳过本场景）", false, bg);
		return rep;
	}
	const rpc = launch({
		extDir: variant,
		work: box.work,
		sessions: box.sessions,
		scenario: "b",
		variant: "current",
		stamp,
		model,
		extraExtensions: [bg],
	});

	try {
		// 1. 垫上下文，让 /compact 真能跑
		await rpc.turn(["用 codemode 执行这段脚本，然后只回复 done：", "", "```js", '// @options: {"max_output_tokens": 20000}', 'const r = await tools.bash({ command: "seq 1 15000" });', "return r.output;", "```"].join("\n"));

		// 2. 后台任务跑完 → 收到 completion 通知
		await rpc.turn(["用 bash 工具在后台跑这条命令（background: true，不要等它）：", "", "```", BG_CMD, "```", "", "提交后只回复一个词：started"].join("\n"));

		let notice: any;
		for (let i = 0; i < 60; i++) {
			const found = (await rpc.entries()).filter((e: any) => e.type === "custom_message" && String(e.customType ?? "").startsWith("pi-bg-bash"));
			if (found.length > 0) {
				notice = found.at(-1);
				break;
			}
			await Bun.sleep(1000);
		}
		rep.check("后台任务产生了 pi-bg-bash 通知条目", Boolean(notice), notice?.customType);
		if (!notice) return rep;

		const idx = numberEntries(await rpc.entries()).notices.findIndex((n) => n.entry.id === notice.id);
		const noticeText = render({ role: "custom", customType: notice.customType, content: notice.content });
		const marker = noticeText.match(/NOTICE_MARKER=([0-9a-f]{8})/)?.[1] ?? "";
		rep.metric("notice", { idx, chars: noticeText.length, marker });
		rep.check("通知里有后台命令的标记", marker.length === 8, marker);
		rep.check("通知长到必须分块（> 2000 字符）", noticeText.length > 2000, noticeText.length);

		// 3. 压缩：通知进入被压缩的历史
		const comp = await rpc.compact();
		rep.metric("compaction", { before: comp.result?.tokensBefore, after: comp.result?.estimatedTokensAfter });
		rep.check("压缩成功", Boolean(comp.result?.summary));
		rep.check("压缩后通知条目仍在 session 里", (await rpc.entries()).some((e: any) => e.id === notice.id));

		// 4. 让它自己找、自己分块读
		await rpc.turn(
			[
				"会话里有一条后台任务完成的通知（不是普通消息，没有 #N 编号）。",
				"用 recall 找到它，先用 notices 取出全文，再用 slice 把这条通知的正文**分块读一遍**（每块不超过 2000 字符），",
				"最后原样告诉我 NOTICE_MARKER 后面那 8 位十六进制值。",
			].join("\n"),
		);

		const finalText = (await rpc.cmd({ type: "get_last_assistant_text" })).data?.text ?? "";
		rep.check("Agent 答对了后台任务的标记", marker !== "" && finalText.includes(marker), finalText.slice(0, 300));

		const { msgs } = numberEntries(await rpc.entries());
		const calls: { name: string; args: any; result: string }[] = [];
		for (const m of msgs) {
			if (m.msg.role !== "assistant") continue;
			for (const p of Array.isArray(m.msg.content) ? m.msg.content : []) {
				if (p.type !== "toolCall") continue;
				const res = msgs.find((r) => r.msg.role === "toolResult" && r.msg.toolCallId === p.id);
				calls.push({ name: p.name, args: p.arguments, result: res ? text(res.msg.content) : "" });
			}
		}
		const recall = calls.filter((c) => c.name === "recall");
		const slices = recall.filter((c) => c.args?.slice?.notice !== undefined);
		rep.metric("tools", calls.map((c) => c.name));
		rep.metric("sliceOffsets", slices.map((c) => Number(c.args.slice.offset ?? 0)));

		// 单条通知时直接试 notice#0 也合理（索引可见空间小），所以只要求"定位到正确的编号"，
		// 走的是 query 还是直接试，记在指标里，不判失败。
		const viaQuery = recall.some((c) => typeof c.args?.query === "string" && c.result.includes(`notice#${idx}`));
		const viaIndex = recall.some((c) => Array.isArray(c.args?.notices) && Number(c.args.notices[0]) === idx);
		rep.metric("locatedVia", viaQuery ? "query" : viaIndex ? "index-guess" : "none");
		rep.check("Agent 定位到了正确的 notice 编号", viaQuery || viaIndex, recall.map((c) => c.args));
		rep.check("Agent 用 notices 取了全文", recall.some((c) => Array.isArray(c.args?.notices)));
		rep.check("Agent 用 slice.notice 分块读，且分了多块", slices.length > 1, slices.length);

		if (slices.length > 0) {
			let cursor = 0;
			let covered = "";
			let bad: unknown = null;
			for (const c of slices) {
				const off = Number(c.args.slice.offset ?? 0);
				if (off !== cursor) {
					bad = { expected: cursor, got: off };
					break;
				}
				const chunk = chunkOf(c.result);
				if (noticeText.slice(off, off + chunk.length) !== chunk) {
					bad = { misalignedAt: off };
					break;
				}
				covered += chunk;
				const next = c.result.match(/next_offset: (\d+|null)/);
				cursor = next && next[1] !== "null" ? Number(next[1]) : -1;
				if (cursor === -1) break;
			}
			rep.check("slice.notice 每步用 next_offset 衔接且逐字对齐", bad === null, bad);
			rep.check("分块拼起来等于整条通知正文", covered === noticeText, { got: covered.length, want: noticeText.length });
		}

		return rep;
	} finally {
		rpc.close();
	}
}

export const scenario: Scenario = { id: "b", title: "后台通知 notice#N → slice.notice 分块", needsBgBash: true, run };
