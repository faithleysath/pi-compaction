/**
 * E2E 的运行环境：变体构造 + 会话启动。
 *
 * 变体不存整份源码副本（会随仓库漂移），而是「当前源码 + 一组字符串补丁」。
 * 这样 A/B 永远比的是同一份代码上的唯一差异，不会因为忘记同步副本而得出假结论。
 */
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Rpc } from "./rpc.ts";

export const REPO = resolve(import.meta.dir, "../..");
export const EXT_DIR = join(REPO, "extensions");
export const TMP = join(process.env.TMPDIR ?? "/tmp", "pi-compaction-e2e");

/** 实验中对比过的长版尾巴，留着是为了让当时的 A/B 可复现 —— 结论是没有观察到增益 */
const TAIL_OLD = 'const TAIL_NOTE = "可用 recall 工具按 #N 取原文；图片可加 image:true 取回。";';
const TAIL_LONG =
	'const TAIL_NOTE = "可用 recall 工具按 #N 取原文（图片加 image:true）；省略的 …(+N)… 不要推断，需要时先按 #N 取原文；历史工具结果只代表当时，当前状态要重新验证。";';

export type Variant = {
	name: string;
	patches?: { file: "pi-compaction" | "pi-recall"; find: string; replace: string }[];
};

export const VARIANTS: Record<string, Variant> = {
	current: { name: "current" },
	/** 曾经提议过的「7 条历史使用规则」的最小替代版，用来复现 A/B */
	"tail-note-long": {
		name: "tail-note-long",
		patches: [{ file: "pi-compaction", find: TAIL_OLD, replace: TAIL_LONG }],
	},
};

/** 把变体落到磁盘，返回扩展目录。current 直接指向仓库，改完代码立刻生效。 */
export function materialize(variantName: string): string {
	const variant = VARIANTS[variantName];
	if (!variant) throw new Error(`unknown variant: ${variantName} (have: ${Object.keys(VARIANTS).join(", ")})`);
	if (!variant.patches?.length) return EXT_DIR;

	const dir = join(TMP, `variant-${variant.name}`);
	mkdirSync(dir, { recursive: true });
	cpSync(EXT_DIR, dir, { recursive: true });
	for (const patch of variant.patches) {
		const path = join(dir, `${patch.file}.ts`);
		const src = readFileSync(path, "utf8");
		if (!src.includes(patch.find)) throw new Error(`variant ${variant.name}: patch anchor not found in ${patch.file}.ts`);
		writeFileSync(path, src.replace(patch.find, patch.replace));
	}
	return dir;
}

export type Sandbox = { work: string; sessions: string };

/** 每次运行一个干净工作区：场景里的文件操作不该跨运行串味 */
export function makeSandbox(scenario: string, stamp: string): Sandbox {
	const work = join(TMP, "work", `${scenario}-${stamp}`);
	const sessions = join(TMP, "sessions");
	mkdirSync(work, { recursive: true });
	mkdirSync(sessions, { recursive: true });
	return { work, sessions };
}

export type LaunchOptions = {
	extDir: string;
	work: string;
	sessions: string;
	scenario: string;
	variant: string;
	stamp: string;
	model: string;
	/** 额外加载的扩展（如 pi-bg-bash 的绝对路径） */
	extraExtensions?: string[];
};

export function launch(opts: LaunchOptions): Rpc {
	const args = ["--no-extensions", "-e", "builtin:codemode"];
	for (const ext of opts.extraExtensions ?? []) args.push("-e", ext);
	args.push(
		"-e",
		join(opts.extDir, "pi-compaction.ts"),
		"-e",
		join(opts.extDir, "pi-recall.ts"),
		"--no-mcp",
		"--no-skills",
		"--no-prompt-templates",
		"--no-context-files",
		"--session-dir",
		opts.sessions,
		"--session-id",
		`e2e-${opts.scenario}-${opts.variant}-${opts.stamp}`,
		"--provider",
		"magpie",
		"--model",
		opts.model,
		"--thinking",
		"low",
	);
	return new Rpc(args, opts.work);
}

/** 跑真实模型需要 pi + 可用凭据；缺了就跳过而不是失败 */
export function piAvailable(): boolean {
	const bin = process.env.PI_BIN ?? Bun.which("pi");
	return Boolean(bin);
}

/** pi-bg-bash 是可选依赖：没装就跳过 B 场景 */
export function bgBashExtension(): string | undefined {
	const guesses = [
		join(process.env.HOME ?? "", ".pi/agent/npm/node_modules/pi-bg-bash/src/index.ts"),
	];
	return guesses.find((p) => {
		try {
			return readFileSync(p, "utf8").length > 0;
		} catch {
			return false;
		}
	});
}
