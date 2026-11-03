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

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
