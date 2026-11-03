/** 场景/运行共用的类型 */
import type { Reporter } from "../report.ts";

export type RunContext = {
	/** 变体落地后的扩展目录 */
	variant: string;
	model: string;
	stamp: string;
	reps: number;
	/** 每次重复的完整 RPC 记录，用于落盘复现 */
	trace: string[];
};

export type Scenario = {
	id: string;
	title: string;
	/** 需要 pi-bg-bash，没装就跳过 */
	needsBgBash?: boolean;
	run(ctx: RunContext): Promise<Reporter>;
};
