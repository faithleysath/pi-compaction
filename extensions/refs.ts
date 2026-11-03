/**
 * #N 编号规则 —— pi-compaction 和 pi-recall 必须用同一套，多一个就全错位。
 *
 * 只数「会进上下文的条目」：
 *   - `role === "system"` 的 loadout 条目是 prompt 状态，不进对话 → 不占号。
 *     paseo 懒加载 MCP 工具时一批写一条 system 条目，占号会让摘要从 [user#5] 起跳。
 *   - `!!` 命令（excludeFromContext）的语义就是「执行但不要给模型看」→ 不占号。
 *   - `custom_message` / `compaction` / `branch_summary` / `custom` 不是 type === "message"，不占号；
 *     扩展通知另有一套 notice#N，见 pi-recall。
 *
 * 编号 0 起，append-only、永不复用；压缩和 /tree 换分支都不会改动已有编号。
 */

export const isNumbered = (entry: any): boolean =>
	entry?.type === "message" &&
	!!entry.message &&
	entry.message.role !== "system" &&
	!(entry.message.role === "bashExecution" && entry.message.excludeFromContext);

/** entry.id → #N */
export const buildRefs = (entries: any[]): Map<string, number> => {
	const refs = new Map<string, number>();
	let n = 0;
	for (const e of entries) if (isNumbered(e)) refs.set(e.id, n++);
	return refs;
};

/** 按顺序列出所有带编号的条目 */
export const numberedEntries = (entries: any[]): { n: number; entry: any }[] => {
	const out: { n: number; entry: any }[] = [];
	let n = 0;
	for (const e of entries) if (isNumbered(e)) out.push({ n: n++, entry: e });
	return out;
};
