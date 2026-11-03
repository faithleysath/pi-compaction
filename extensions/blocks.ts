/**
 * 块边界：一条条目 = 从「行首是结构标记」到下一个结构标记为止。
 *
 * 两个折叠器（工具折叠 / paseo 信封折叠）必须用同一套边界，否则会互相吞记录：
 * 折叠出来的行（`(collapsed …)`、`[background] …`、`[paseo] …`）如果不算结构行，
 * 就会被**前一个工具块**吸进去，那个块被折成 `(collapsed …)` 时它们一起消失 ——
 * 连 `#N` 召回线索都没了（实测：paseo 通知被吞后，模型再也不知道要 recall #3）。
 *
 * 正文里的伪造由 `esc()` 负责：行首 `[user` / `[assistant` / `[paseo]` / `* ` / `→` / `---`
 * 会被加反斜杠，`(collapsed ` 会被转义成 `(\collapsed `。所以这里可以放心一律当边界。
 */
export const BLOCK_START =
	/^(\[user(?=[#\]])|\[assistant(?=[#\]])|\* |→(?=[ #])|\(collapsed |\[background\] |\[paseo\] |---\s*$)/;

/** 按结构行切块。首行的标记决定这个块是什么（工具 / 条目 / 折叠行） */
export const splitBlocks = (text: string): string[][] => {
	const blocks: string[][] = [];
	let cur: string[] | null = null;
	for (const line of text.split("\n")) {
		if (BLOCK_START.test(line)) {
			if (cur) blocks.push(cur);
			cur = [line];
		} else if (cur) cur.push(line);
		else cur = [line];
	}
	if (cur) blocks.push(cur);
	return blocks;
};
