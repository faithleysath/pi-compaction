/**
 * 场景 C · 召回触发：摘要里只剩「失败了」，真正的原因落在被截断的中间。
 * 模型会不会主动 recall，而不是拿「exit code 1」凑一个解释？
 *
 * 关键设计：失败原因由磁盘上的脚本随机抽一条打印，命令文本里不含任何原因，
 * 所以重跑、读脚本都只能拿到候选集，拿不到「那一次」的答案。
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { launch, makeSandbox } from "../env.ts";
import { Reporter } from "../report.ts";
import { numberEntries, render } from "../rpc.ts";
import type { RunContext, Scenario } from "./types.ts";

const DEPLOY_PY = `import random, sys
causes = [
    "pip install torch==2.4 timed out after 900s",
    "docker build failed: no space left on device (/var/lib/docker)",
    "k8s apply rejected: resource quotas exceeded in namespace prod",
    "ssl cert verify failed: certificate has expired",
    "postgres migration 0042 blocked by a long-running transaction",
]
for i in range(1, 201):
    print(f"[build] step {i}: compiling module_{i}")
print("[deploy] pushing to cluster...")
print("ERROR " + random.choice(causes))
for i in range(202, 401):
    print(f"[build] step {i}: compiling module_{i}")
print("Process exited with code 1")
sys.exit(1)
`;

const PAD = ["```js", '// @options: {"max_output_tokens": 60000}', 'const r = await tools.bash({ command: "seq 1 40000" });', "return r.output;", "```"].join("\n");

type Rep = { recalled: boolean; correct: boolean; tools: string[]; cause: string; ctxAfter: number | null };

async function run({ variant, model, stamp, reps, trace }: RunContext) {
	const agg = new Reporter();
	const runs: Rep[] = [];

	for (let i = 0; i < reps; i++) {
		const box = makeSandbox("c", `${stamp}-${i}`);
		writeFileSync(join(box.work, "deploy.py"), DEPLOY_PY);
		const rpc = launch({ extDir: variant, work: box.work, sessions: box.sessions, scenario: "c", variant: "current", stamp: `${stamp}-${i}`, model });
		try {
			// 1. 失败部署（必须排在垫料前，才落进被压缩的那一段）
			await rpc.turn(["用 bash 工具跑这条命令，然后只回复 done：", "", "```", "python3 deploy.py", "```"].join("\n"));

			// 2. 垫上下文，把 deploy 推出 keepRecentTokens 窗口
			await rpc.turn(["用 codemode 执行这段脚本，然后只回复 done：", "", PAD].join("\n"));

			// 3. 压缩
			const beforeAsk = numberEntries(await rpc.entries()).msgs.length;
			const comp = await rpc.compact();
			const summary = comp.result?.summary ?? "";

			// 4. 问「为什么失败」。只说问题，不说方法。
			await rpc.turn("刚才那次 deploy 为什么挂了？具体是哪个环节出的问题？");

			const finalText = (await rpc.cmd({ type: "get_last_assistant_text" })).data?.text ?? "";
			const after = numberEntries(await rpc.entries()).msgs;
			const deployOut = after
				.filter((m) => m.msg.role === "toolResult")
				.map((m) => render(m.msg))
				.join("\n");
			const cause = (deployOut.split("\n").find((l) => l.startsWith("ERROR ")) ?? "").slice(6, 26);
			const tools: string[] = [];
			for (const m of after.slice(beforeAsk)) {
				if (m.msg.role !== "assistant") continue;
				for (const p of Array.isArray(m.msg.content) ? m.msg.content : []) if (p.type === "toolCall") tools.push(p.name);
			}
			const recalled = tools.includes("recall");
			const correct = cause.length > 8 && finalText.includes(cause);
			const ctxAfter = (await rpc.stats()).contextUsage?.tokens ?? null;
			runs.push({ recalled, correct, tools, cause, ctxAfter });
			agg.metric(`rep${i + 1}`, {
				recalled,
				correct,
				tools,
				cause,
				ctxAfter,
				summaryLeaksCause: /ERROR |torch|docker build|quotas|certificate|migration 0042/.test(summary),
			});
			console.log(`    #${i + 1} recall=${recalled ? "Y" : "n"} 答对=${correct ? "Y" : "n"} 调用=${tools.join("+") || "-"} 原因=${cause}`);
			trace.push(...rpc.log.map((r) => JSON.stringify(r)));
		} catch (e: any) {
			console.log(`    #${i + 1} 异常：${e.message}`);
			agg.check(`第 ${i + 1} 次运行没有异常`, false, e.message);
		} finally {
			rpc.close();
		}
	}

	const n = runs.length || 1;
	const recallRate = runs.filter((r) => r.recalled).length / n;
	const correctRate = runs.filter((r) => r.correct).length / n;
	agg.metric("recallRate", recallRate);
	agg.metric("correctRate", correctRate);
	agg.metric("avgTools", runs.reduce((a, r) => a + r.tools.length, 0) / n);
	agg.check("每次都在提问后主动 recall（拿证据再回答）", runs.every((r) => r.recalled), runs.map((r) => r.tools));
	agg.check("每次都答对了真实原因", runs.every((r) => r.correct), runs.map((r) => r.cause));
	console.log(`    → 召回 ${(recallRate * 100).toFixed(0)}%，答对 ${(correctRate * 100).toFixed(0)}%`);
	return agg;
}

export const scenario: Scenario = { id: "c", title: "摘要缺细节时是否主动召回", run };
