/**
 * 结果记录：每次都把「模型 / 工具调用序列 / recall 次数 / 是否答对 / token 消耗」落盘，
 * 方便以后翻旧账 —— 提示词改动的结论不能只活在对话里。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO } from "./env.ts";

export type Check = { name: string; ok: boolean; info?: unknown };

export class Reporter {
	checks: Check[] = [];
	metrics: Record<string, unknown> = {};

	check(name: string, ok: boolean, info?: unknown) {
		this.checks.push({ name, ok, info });
		console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok || info === undefined ? "" : `  ${JSON.stringify(info).slice(0, 300)}`}`);
	}

	metric(key: string, value: unknown) {
		this.metrics[key] = value;
	}

	merge(other: Reporter) {
		this.checks.push(...other.checks);
		Object.assign(this.metrics, other.metrics);
	}

	get ok() {
		return this.checks.every((c) => c.ok);
	}
}

export const RUNS_DIR = join(REPO, "tests/e2e/.runs");

export function writeRun(data: {
	scenario: string;
	variant: string;
	model: string;
	stamp: string;
	checks: Check[];
	metrics: Record<string, unknown>;
	reps?: unknown[];
	trace?: string[];
}): string {
	mkdirSync(RUNS_DIR, { recursive: true });
	const base = join(RUNS_DIR, `${data.stamp}-${data.scenario}-${data.variant}`);
	writeFileSync(`${base}.json`, JSON.stringify(data, null, 1));
	if (data.trace?.length) writeFileSync(`${base}.trace.jsonl`, data.trace.join("\n"));
	return `${base}.json`;
}
