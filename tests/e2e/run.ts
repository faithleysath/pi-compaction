/**
 * E2E 入口。真模型、真 pi 进程，所以默认不进 `bun test`。
 *
 *   bun run tests/e2e/run.ts                              # 四个场景各跑 1 次
 *   bun run tests/e2e/run.ts a,b                          # 只跑指定场景
 *   bun run tests/e2e/run.ts c --reps=4                   # 行为场景多跑几次
 *   bun run tests/e2e/run.ts c --variants=current,tail-note-long   # A/B
 *   bun run tests/e2e/run.ts --model=zcode/GLM-5.3
 *
 * 产物：tests/e2e/.runs/<stamp>-<scenario>-<variant>.json（含指标与检查）
 *      同名 .trace.jsonl（完整 RPC 记录，可回放）
 */
import { materialize, piAvailable, VARIANTS } from "./env.ts";
import { Reporter, writeRun } from "./report.ts";
import { scenario as a } from "./scenarios/a-long-entry.ts";
import { scenario as b } from "./scenarios/b-notice.ts";
import { scenario as c } from "./scenarios/c-recall-trigger.ts";
import { scenario as d } from "./scenarios/d-stale-state.ts";
import type { Scenario } from "./scenarios/types.ts";

const ALL: Scenario[] = [a, b, c, d];

const arg = (name: string, dflt?: string) => {
	const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
	return hit ? hit.slice(name.length + 3) : dflt;
};

const only = (arg("only") ?? process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "a,b,c,d").split(",").filter(Boolean);
const variants = (arg("variants") ?? "current").split(",").filter(Boolean);
const model = arg("model") ?? process.env.E2E_MODEL ?? "zcode/GLM-5.3";
const repsArg = Number(arg("reps") ?? "1");

if (!piAvailable()) {
	console.log("找不到 pi，跳过 E2E（设 PI_BIN 指向 pi 可执行文件）");
	process.exit(0);
}

console.log(`E2E · 模型 ${model} · 场景 ${only.join(",")} · 变体 ${variants.join(",")} · repeats ${repsArg}\n`);

const summary: { scenario: string; variant: string; ok: boolean; checks: number; failed: number; file: string }[] = [];
let failures = 0;

for (const id of only) {
	const sc = ALL.find((s) => s.id === id);
	if (!sc) {
		console.log(`未知场景 ${id}（有 ${ALL.map((s) => s.id).join(",")}）`);
		failures++;
		continue;
	}
	for (const variantName of variants) {
		if (!VARIANTS[variantName]) {
			console.log(`未知变体 ${variantName}（有 ${Object.keys(VARIANTS).join(",")}）`);
			failures++;
			continue;
		}
		console.log(`[${sc.id}] ${sc.title} · 变体 ${variantName}`);
		const stamp = `${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 6)}`;
		const trace: string[] = [];
		const agg = new Reporter();
		try {
			const rep = await sc.run({ variant: materialize(variantName), model, stamp, reps: repsArg, trace });
			agg.merge(rep);
		} catch (e: any) {
			agg.check(`${sc.id} 运行完成`, false, e?.message);
		}
		const file = writeRun({
			scenario: sc.id,
			variant: variantName,
			model,
			stamp,
			checks: agg.checks,
			metrics: agg.metrics,
			trace,
		});
		const failed = agg.checks.filter((x) => !x.ok).length;
		if (failed > 0) failures++;
		summary.push({ scenario: sc.id, variant: variantName, ok: agg.ok, checks: agg.checks.length, failed, file: file.replace(/^.*tests\/e2e\//, "tests/e2e/") });
		console.log("");
	}
}

console.log("汇总");
for (const s of summary) {
	console.log(`  ${s.ok ? "ok  " : "FAIL"} ${s.scenario}/${s.variant}: ${s.checks - s.failed}/${s.checks} 项通过  ${s.file}`);
}
process.exit(failures > 0 ? 1 : 0);
