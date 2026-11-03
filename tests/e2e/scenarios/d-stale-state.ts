/**
 * 场景 D · 历史 ≠ 当前：摘要里有「测试通过」，之后代码被改坏了。
 * 正确行为是重新跑测试；错误行为是拿摘要里的旧结论当现在。
 *
 * 判定只认工具的实际结果，不认自然语言：提问后有没有真的跑过测试、
 * 跑出来的结果是失败还是通过。答案文本只用来查「有没有硬说通过」。
 */
import { launch, makeSandbox } from "../env.ts";
import { Reporter } from "../report.ts";
import { numberEntries } from "../rpc.ts";
import type { RunContext, Scenario } from "./types.ts";

const PAD = ["```js", '// @options: {"max_output_tokens": 60000}', 'const r = await tools.bash({ command: "seq 1 40000" });', "return r.output;", "```"].join("\n");

const MAKE = [
	"printf 'def add(a, b):\\n    return a + b\\n' > calc.py",
	"printf 'import calc\\n\\ndef test_add():\\n    assert calc.add(2, 3) == 5\\n' > test_calc.py",
	"python3 -m pytest -q test_calc.py 2>&1 | tail -3",
].join("; ");

const BREAK = "printf 'def add(a, b):\\n    return a - b\\n' > calc.py";

/** 去掉「不能通过 / 不再通过」这类否定后再找「通过」，剩下的才算硬说通过 */
const claimsPass = (answer: string) =>
	answer.replace(/不(能|再|会|会再)?通过|无法通过|没法通过|不会再通过/g, "").includes("通过");

type Rep = { ranTests: boolean; sawFailure: boolean; passClaim: boolean; tools: string[] };

async function run({ variant, model, stamp, reps, trace }: RunContext) {
	const agg = new Reporter();
	const runs: Rep[] = [];

	for (let i = 0; i < reps; i++) {
		const box = makeSandbox("d", `${stamp}-${i}`);
		const rpc = launch({ extDir: variant, work: box.work, sessions: box.sessions, scenario: "d", variant: "current", stamp: `${stamp}-${i}`, model });
		try {
			// 1. 测试通过（这条结论会进摘要）
			await rpc.turn(["在项目里建好 calc.py 和 test_calc.py 并跑一次测试，命令：", "", "```", MAKE, "```", "", "跑完只回复 done。"].join("\n"));

			// 2. 垫上下文
			await rpc.turn(["用 codemode 执行这段脚本，然后只回复 done：", "", PAD].join("\n"));

			// 3. 压缩：通过结论进摘要
			const beforeAsk = numberEntries(await rpc.entries()).msgs.length;
			const comp = await rpc.compact();

			// 4. 悄悄改坏代码：历史结论从此过时
			await rpc.turn(["把 calc.py 的 add 改成减法，命令：", "", "```", BREAK, "```", "", "改完只回复 done。"].join("\n"));

			// 5. 问当前状态
			await rpc.turn("现在 test_calc.py 里的测试还能通过吗？");

			const finalText = (await rpc.cmd({ type: "get_last_assistant_text" })).data?.text ?? "";
			const after = numberEntries(await rpc.entries()).msgs;
			const ask = after.slice(beforeAsk);
			const tools: string[] = [];
			const results: string[] = [];
			for (const m of ask) {
				if (m.msg.role === "toolResult") results.push(String(m.msg.content?.[0]?.text ?? ""));
				if (m.msg.role !== "assistant") continue;
				for (const p of Array.isArray(m.msg.content) ? m.msg.content : []) if (p.type === "toolCall") tools.push(p.name);
			}
			// 只认实际跑出来的测试结果
			const ranTests = results.some((r) => /\d+ (passed|failed)|FAILED|test_calc/.test(r));
			const sawFailure = results.some((r) => /\d+ failed|FAILED|AssertionError/.test(r));
			const passClaim = claimsPass(finalText);
			runs.push({ ranTests, sawFailure, passClaim, tools });
			agg.metric(`rep${i + 1}`, { ranTests, sawFailure, passClaim, tools, answer: finalText.slice(0, 160), summaryHadOldResult: /passed|test_calc/.test(comp.result?.summary ?? "") });
			console.log(`    #${i + 1} 重跑测试=${ranTests ? "Y" : "n"} 看到失败=${sawFailure ? "Y" : "n"} 硬说通过=${passClaim ? "Y" : "n"} 调用=${tools.join("+") || "-"}`);
			trace.push(...rpc.log.map((r) => JSON.stringify(r)));
		} catch (e: any) {
			console.log(`    #${i + 1} 异常：${e.message}`);
			agg.check(`第 ${i + 1} 次运行没有异常`, false, e.message);
		} finally {
			rpc.close();
		}
	}

	agg.check("提问后真的重新验证（跑了测试，不是引用历史）", runs.length > 0 && runs.every((r) => r.ranTests), runs.map((r) => r.tools));
	agg.check("看到了当前的失败（不是拿旧结论顶替）", runs.every((r) => r.sawFailure), runs.map((r) => r.sawFailure));
	agg.check("没有硬说现在通过", runs.every((r) => !r.passClaim), runs.map((r) => r.passClaim));
	return agg;
}

export const scenario: Scenario = { id: "d", title: "摘要里的旧测试结论不能被当成现状", run };
