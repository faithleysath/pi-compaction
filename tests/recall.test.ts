/**
 * pi-recall 行为测试：直接调用真实 tool.execute，不经过 pi 进程。
 *   bun run tests/recall.test.ts
 */
import ext from "../extensions/pi-recall.ts";

const tools: Record<string, any> = {};
ext({ registerTool: (t: any) => { tools[t.name] = t; }, on: () => {} } as any);
const recall = tools["recall"];
if (!recall) throw new Error("recall 工具未注册");

let pass = 0, fail = 0;
function check(name: string, cond: boolean, info?: any) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`, info === undefined ? "" : JSON.stringify(info).slice(0, 240)); }
}

const T = (t: string) => [{ type: "text", text: t }];
const mk = (id: string, role: string, content: any[], extra: any = {}): any =>
  ({ id, type: "message", message: { role, content, ...extra } });

async function call(entries: any[], params: any): Promise<{ text: string; blocks: any[] }> {
  const ctx: any = { sessionManager: { getEntries: () => entries } };
  const r: any = await recall.execute("id", params, undefined, undefined, ctx);
  return { text: r.content.map((c: any) => c.text ?? "").join(""), blocks: r.content };
}

/** 孤立代理项：真值表示字符串里有不成对的 UTF-16 代理项——过线就可能变成 U+FFFD */
const hasLoneSurrogate = (s: string) => {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const nx = s.charCodeAt(i + 1);
      if (!(nx >= 0xdc00 && nx <= 0xdfff)) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) return true;
  }
  return false;
};

const MARK_A = "--- CONTENT START ---\n";
const MARK_B = "\n--- CONTENT END ---";
const bodyOf = (t: string) => {
  const i = t.indexOf(MARK_A);
  const j = t.lastIndexOf(MARK_B);
  return i >= 0 && j >= i ? t.slice(i + MARK_A.length, j) : t;
};

/** 顺着 next_offset 一直读到底，用于验证“拼回来 === 原文” */
async function sliceAll(entries: any[], params: any, limit = 20_000) {
  let offset = 0, text = "", calls = 0, monotonic = true;
  const chunks: string[] = [], offsets: number[] = [];
  for (;;) {
    const r = await call(entries, { slice: { ...params, offset, limit } });
    calls++;
    chunks.push(bodyOf(r.text));
    text += chunks[chunks.length - 1];
    const m = r.text.match(/next_offset: (\d+|null)/);
    if (!m) throw new Error(`没有 next_offset: ${r.text.slice(0, 200)}`);
    if (m[1] === "null") return { text, calls, chunks, offsets, monotonic, last: r.text };
    const next = Number(m[1]);
    if (next <= offset) monotonic = false;
    offsets.push(next);
    offset = next;
    if (calls > 2000) throw new Error("没读到结尾，可能死循环");
  }
}

console.log("[1] query 搜索全文（不是只搜前 800 字符）");
{
  const lead = "前".repeat(1200);
  const entries = [
    mk("u1", "user", T(lead + "\n关键需求XYZ")),
    mk("a1", "assistant", T("回复")),
    mk("r1", "toolResult", T(lead + "\nFATAL_ERROR_ABC"), { toolName: "bash", toolCallId: "tc1" }),
  ];
  check("用户消息 800 字之后的关键词能搜到", (await call(entries, { query: "关键需求XYZ" })).text.includes("#0"));
  check("工具结果 800 字之后的关键词能搜到", (await call(entries, { query: "FATAL_ERROR_ABC" })).text.includes("#2"));
  check("assistant 正文里的关键词能搜到", (await call(entries, { query: "回复" })).text.includes("#1"));
  const none = await call(entries, { query: "不存在的词zzz" });
  check("搜不到时给提示", none.text.includes("no matches"));
}

console.log("\n[2] 单字符关键词不被过滤");
{
  const entries = [mk("u1", "user", T("这里有个 中 字"))];
  const out = await call(entries, { query: "中" });
  check("单字关键词有命中", !out.text.includes("no matches"), out.text);
}

console.log("\n[3] expand 文本预算");
{
  const big = "z".repeat(100_000);
  const entries = [mk("r0", "toolResult", T(big), { toolName: "bash", toolCallId: "tc0" })];
  const out = await call(entries, { expand: [0] });
  check("10 万字符的单条被截断", out.text.length < 70_000, out.text.length);
  check("给了截断提示", out.text.includes("文本上限"), out.text.slice(-200));
}

console.log("\n[4] 批量 expand 受总预算约束");
{
  const entries = Array.from({ length: 10 }, (_, i) =>
    mk(`r${i}`, "toolResult", T("w".repeat(20_000)), { toolName: "bash", toolCallId: `tc${i}` }));
  const out = await call(entries, { expand: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] });
  check("10×2 万字符被预算截住", out.text.length < 75_000, out.text.length);
  check("提示了截断条数", /（\d+ 条因超出单次文本上限/.test(out.text), out.text.slice(-200));
}

console.log("\n[5] 图片上限");
{
  const img = { type: "image", data: "a".repeat(1000), mimeType: "image/png" };
  const many = Array.from({ length: 10 }, (_, i) =>
    mk(`r${i}`, "toolResult", [img], { toolName: "read", toolCallId: `tc${i}` }));
  const out = await call(many, { expand: [0,1,2,3,4,5,6,7,8,9], image: true });
  const imgs = out.blocks.filter((b: any) => b.type === "image");
  check("最多 6 张图", imgs.length <= 6, imgs.length);
}

console.log("\n[6] !! 命令内容不外泄");
{
  const entries = [
    mk("b1", "bashExecution", [], { command: "cat ~/.ssh/id_rsa", output: "PRIVATE KEY", exitCode: 0, cancelled: false, truncated: false, excludeFromContext: true, timestamp: 0 }),
    mk("u1", "user", T("正常消息")),
  ];
  const expandOut = await call(entries, { expand: [0] });
  check("expand 不返回 !! 的内容", !expandOut.text.includes("PRIVATE KEY"), expandOut.text);
  const queryOut = await call(entries, { query: "PRIVATE" });
  check("query 搜不到 !! 的内容", queryOut.text.includes("no matches"), queryOut.text);
}

console.log("\n[7] 编号与 compaction 一致（只数 type==='message'）");
{
  const entries = [
    mk("u0", "user", T("第 0 条")),
    { id: "c1", type: "compaction", summary: "摘要", firstKeptEntryId: "u0" },
    { id: "cm1", type: "custom_message", customType: "bg", content: "通知", display: true },
    mk("u1", "user", T("第 1 条")),
  ];
  const out = await call(entries, { expand: [1] });
  check("compaction 和 custom_message 不占号", out.text.includes("#1") && out.text.includes("第 1 条"), out.text);
}

console.log("\n[8] 扩展通知：query 能搜到，notices 能取全文，且不占 #N");
{
  const entries = [
    mk("u1", "user", T("起构建")),
    mk("a1", "assistant", T("好")),
    { id: "cm1", type: "custom_message", customType: "pi-bg-bash", content: "Background task bg-1 finished: exited (code 0)\nBUILD_OK_TAG", display: true },
    { id: "cm2", type: "custom_message", customType: "pi-bg-bash-output", content: "Task bg-3; 0 lost\nWATCH_LINE_TAG", display: true },
    mk("u2", "user", T("后续")),
  ];
  const q1 = await call(entries, { query: "BUILD_OK_TAG" });
  check("query 能搜到完成通知", q1.text.includes("notice#0"), q1.text);
  check("命中项标了 customType", q1.text.includes("pi-bg-bash"), q1.text);
  const q2 = await call(entries, { query: "WATCH_LINE_TAG" });
  check("query 能搜到 watch 输出", q2.text.includes("notice#1"), q2.text);

  const nt = await call(entries, { notices: [0] });
  check("notices 取全文", nt.text.includes("BUILD_OK_TAG"), nt.text.slice(0, 120));

  const ex = await call(entries, { expand: [2] });
  check("通知不占 #N（#2 仍是 user 消息）", ex.text.includes("#2") && ex.text.includes("后续"), ex.text.slice(0, 80));

  const lim = await call(entries, { notices: [0, 1] });
  check("notices 也受文本预算约束", lim.text.length < 120_000);
}

console.log(`\n[9] slice：单条无损分块`);
{
  const body = Array.from({ length: 3000 }, (_, i) => `line ${i} ${"x".repeat(20)}`).join("\n");
  const entries = [mk("r0", "toolResult", T(body), { toolName: "bash", toolCallId: "tc0" })];
  const expected = `[toolResult:bash]\n${body}`;
  const all = await sliceAll(entries, { message: 0 });
  check("129k 字符分块后拼回 === render 全文", all.text === expected, { got: all.text.length, want: expected.length });
  check("确实分了多块", all.calls > 1, all.calls);
  check("offset 每步严格递增", all.monotonic, all.offsets);
  check("末块 has_more:false 且 next_offset:null", /has_more: false/.test(all.last) && /next_offset: null/.test(all.last), all.last.slice(0, 160));
  check("末块带“读完了”提示", all.last.includes("已到末尾"));

  const half = await call(entries, { slice: { message: 0, offset: 20_000, limit: 20_000 } });
  check("返回头含 total/offset/next_offset/has_more",
    /total_chars: \d+/.test(half.text) && /offset: 20000/.test(half.text) && /next_offset: \d+/.test(half.text) && /has_more: true/.test(half.text), half.text.slice(0, 200));
  check("给了可执行的继续调用", /继续：\{"slice":\{"message":0,"offset":\d+\}\}/.test(half.text), half.text.slice(-120));
  check("正文用 CONTENT 包裹", half.text.includes("--- CONTENT START ---") && half.text.includes("--- CONTENT END ---"));
}

console.log("\n[10] slice：换行对齐 / emoji 边界 / 必须有进展");
{
  const body = Array.from({ length: 200 }, (_, i) => `L${i}`).join("\n");
  const expected = `[user]\n${body}`;
  const entries = [mk("u0", "user", T(body))];
  const all = await sliceAll(entries, { message: 0 }, 40);
  check("小 limit 也能拼回原文", all.text === expected, { got: all.text.length, want: expected.length });
  check("每块都尽量完整行（不以半个换行结尾）", all.chunks.every((c) => !c.endsWith("L")), all.chunks.slice(0, 3));

  // 全是代理对：不管怎么切，拼回来必须逐字一致
  const emoji = "😀".repeat(500);
  const eEntries = [mk("u1", "user", T(emoji))];
  const eAll = await sliceAll(eEntries, { message: 0 }, 3);
  check("emoji 消息分块后逐字一致", eAll.text === `[user]\n${emoji}`, eAll.text.length);
  check("边界没切断代理对", eAll.chunks.every((c) => !/[\uD800-\uDBFF]$/.test(c)), eAll.chunks.slice(0, 3));

  // limit 极小（1）时必然要碰代理对边界，也必须前进、不吐孤立代理项、且拼回一致
  const tiny = await sliceAll(eEntries, { message: 0 }, 1);
  check("limit:1 不死循环且有进展", tiny.calls > 100 && tiny.monotonic, tiny.calls);
  check("limit:1 拼回仍逐字一致", tiny.text === `[user]\n${emoji}`, tiny.text.length);
  check("limit:1 也不吐孤立代理项", tiny.chunks.every((c) => !hasLoneSurrogate(c)), tiny.chunks.slice(0, 3));
  check("所有分块都不含孤立代理项", [...all.chunks, ...eAll.chunks].every((c) => !hasLoneSurrogate(c)));

  // 手写的 offset 落在代理对中间：退到高代理项，并在元数据里报实际 offset
  const mid = await call(eEntries, { slice: { message: 0, offset: 8, limit: 5 } });
  check("手动 offset 落在 emoji 中间时已对齐", mid.text.includes("offset: 7") && mid.text.includes("已对齐"), mid.text.slice(0, 220));
  check("对齐后正文不含孤立代理项", !hasLoneSurrogate(bodyOf(mid.text)), mid.text.slice(0, 200));

  // 任意 offset（含每一个中间码元）都不应吐出孤立代理项
  const small = [mk("u9", "user", T("a😀b😀c"))];
  const smallTotal = `[user]\n${"a😀b😀c"}`.length;
  let sweepOk = true, sweepAt = -1;
  for (let off = 0; off <= smallTotal; off++) {
    const r = await call(small, { slice: { message: 0, offset: off, limit: 2 } });
    if (hasLoneSurrogate(bodyOf(r.text))) { sweepOk = false; sweepAt = off; break; }
  }
  check("任意 offset（0..total）都不产生孤立代理项", sweepOk, sweepAt);

  // 为了不拆代理对，实际返回可能比 limit 多 1 个码元，但不会更多
  const one = await call(eEntries, { slice: { message: 0, offset: 7, limit: 1 } });
  check("碰 emoji 边界时只多拿 1 个码元", one.text.includes("returned_chars: 2"), one.text.slice(0, 140));
  check("limit:40 的分块最多多 1 个码元", all.chunks.every((c) => c.length <= 41), Math.max(...all.chunks.map((c) => c.length)));
}

console.log("\n[11] slice：参数容错与边界");
{
  const entries = [
    mk("r0", "toolResult", T("0123456789".repeat(10)), { toolName: "bash", toolCallId: "tc0" }),
    mk("cm0", "custom", []), // 占号，不影响
  ];
  const total = `[toolResult:bash]\n${"0123456789".repeat(10)}`.length;
  check("数字字符串也被接受", (await call(entries, { slice: { message: "0", offset: "10", limit: "5" } })).text.includes("offset: 10"));
  check("小数向下取整", (await call(entries, { slice: { message: 0, offset: 4.9 } })).text.includes("offset: 4"));
  check("负数 offset 夹到 0", (await call(entries, { slice: { message: 0, offset: -50 } })).text.includes("offset: 0"));
  const clamped = await call(entries, { slice: { message: 0, limit: 999_999 } });
  check("limit 被夹到 50000 并说明", clamped.text.includes("已夹到 50000"), clamped.text.slice(0, 200));
  const zero = await call(entries, { slice: { message: 0, limit: 0 } });
  check("limit:0 用默认值而不是空块", /returned_chars: (?!0$)\d+/.test(zero.text), zero.text.slice(0, 200));
  const atEnd = await call(entries, { slice: { message: 0, offset: total } });
  check("offset === total：空内容 + has_more:false", atEnd.text.includes("returned_chars: 0") && atEnd.text.includes("has_more: false"), atEnd.text.slice(0, 200));
  const past = await call(entries, { slice: { message: 0, offset: total + 99 } });
  check("offset 越界有明确提示", past.text.includes("超出总长度") && past.text.includes("has_more: false"), past.text.slice(0, 200));
  check("编号不存在报 no such entry", (await call(entries, { slice: { message: 999 } })).text.includes("no such entry"));
  check("notice 不存在报 no such notification", (await call(entries, { slice: { notice: 7 } })).text.includes("no such notification"));
  check("message 和 notice 同时给要报错", (await call(entries, { slice: { message: 0, notice: 0 } })).text.includes("exactly one"));
  check("都不给要报错", (await call(entries, { slice: {} })).text.includes("give slice.message"));
}

console.log("\n[12] slice：!! 命令不泄漏，图片不重复吐");
{
  const entries = [
    mk("b1", "bashExecution", [], { command: "cat ~/.ssh/id_rsa", output: "PRIVATE KEY".repeat(100), exitCode: 0, cancelled: false, truncated: false, excludeFromContext: true, timestamp: 0 }),
  ];
  const out = await call(entries, { slice: { message: 0, limit: 50_000 } });
  check("slice 拿不到 !! 的内容", !out.text.includes("PRIVATE KEY"), out.text.slice(0, 200));
  check("slice 也不报 no such entry（占号但内容排除）", !out.text.includes("no such entry"), out.text.slice(0, 120));

  const imgEntries = [mk("r1", "toolResult", [{ type: "image", data: "a".repeat(500), mimeType: "image/png" }], { toolName: "read", toolCallId: "tc1" })];
  const imgOut = await call(imgEntries, { slice: { message: 0 } });
  check("slice 只给图片占位符，不带图块", imgOut.blocks.every((b: any) => b.type !== "image") && imgOut.text.includes("[image png]"), imgOut.text.slice(0, 120));
}

console.log("\n[13] 截断提示必须精确到具体条目、且可执行");
{
  const bodies = ["A".repeat(20_000), "B".repeat(20_000), "C".repeat(20_000)];
  const entries = bodies.map((b, i) => mk(`r${i}`, "toolResult", T(b), { toolName: "bash", toolCallId: `tc${i}` }));
  const fulls = bodies.map((b) => `[toolResult:bash]\n${b}`);
  const out = await call(entries, { expand: [0, 1, 2] });
  const usedByFirstTwo = fulls[0].length + fulls[1].length;
  const wantOffset = 60_000 - usedByFirstTwo;
  check("#2 的提示用自己的编号和已给字符数", out.text.includes(`{"slice":{"message":2,"offset":${wantOffset}}}`), { wantOffset, tail: out.text.slice(-300) });
  check("提示可执行：按它取下一块，正好接上",
    (await call(entries, { slice: { message: 2, offset: wantOffset, limit: 20_000 } })).text.includes(fulls[2].slice(wantOffset, wantOffset + 50)));
  check("批量截断汇总不再建议“更小的 expand”", !out.text.includes("更小的 expand"), out.text.slice(-200));

  // 自动配对的 toolResult 用自己的 #N
  const paired = [
    { id: "a0", type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "tc9", name: "bash", arguments: { command: "deploy" } }] } },
    mk("r9", "toolResult", T("Z".repeat(100_000)), { toolName: "bash", toolCallId: "tc9" }),
  ];
  const pOut = await call(paired, { expand: [0] });
  check("配对结果用自己的 #1", pOut.text.includes(`{"slice":{"message":1,"offset":`), pOut.text.slice(-260));

  const nEntries = [
    mk("u0", "user", T("hi")),
    { id: "cm1", type: "custom_message", customType: "pi-bg-bash-output", content: "Q".repeat(100_000), display: true },
  ];
  const nOut = await call(nEntries, { notices: [0] });
  check("notices 截断提示指向 slice.notice", nOut.text.includes(`{"slice":{"notice":0,"offset":60000}}`), nOut.text.slice(-160));
  const nAll = await sliceAll(nEntries, { notice: 0 });
  check("notice 也能分块读完", nAll.text === `[pi-bg-bash-output notice]\n${"Q".repeat(100_000)}`, nAll.text.length);
}

console.log("\n[14] 追加新消息后旧编号仍可 slice");
{
  const body = "0123456789" + "K".repeat(200);
  const entries = [mk("u0", "user", T(body))];
  const before = await call(entries, { slice: { message: 0, offset: 100, limit: 50 } });
  entries.push(mk("u1", "user", T("后面加的")));
  const after = await call(entries, { slice: { message: 0, offset: 100, limit: 50 } });
  check("追加消息后同一 offset 返回同一内容", before.text.replace(/progress: \d+%/, "") === after.text.replace(/progress: \d+%/, ""));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
