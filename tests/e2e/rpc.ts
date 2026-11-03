/**
 * 极简 pi RPC 客户端：JSONL over stdin/stdout，用来驱动真实 pi 会话做端到端验证。
 */
const PI = process.env.PI_BIN ?? Bun.which("pi") ?? "pi";

export type Rec = any;

export class Rpc {
	log: Rec[] = [];
	stderrText = "";
	private buf = "";
	private seq = 0;
	private waiters: { pred: (r: Rec) => boolean; resolve: (r: Rec) => void; reject: (e: any) => void; timer: any }[] = [];
	proc: any;

	constructor(cliArgs: string[], cwd: string) {
		this.proc = Bun.spawn([PI, "--mode", "rpc", ...cliArgs], {
			cwd,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, PI_OFFLINE: "0" },
		});
		void this.readLoop();
		void this.errLoop();
	}

	private dispatch(rec: Rec) {
		this.log.push(rec);
		for (let i = this.waiters.length - 1; i >= 0; i--) {
			const w = this.waiters[i];
			if (!w.pred(rec)) continue;
			clearTimeout(w.timer);
			this.waiters.splice(i, 1);
			w.resolve(rec);
		}
	}

	private async readLoop() {
		const reader = this.proc.stdout.getReader();
		const dec = new TextDecoder();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			this.buf += dec.decode(value, { stream: true });
			for (;;) {
				const nl = this.buf.indexOf("\n");
				if (nl < 0) break;
				const line = this.buf.slice(0, nl).replace(/\r$/, "");
				this.buf = this.buf.slice(nl + 1);
				if (!line.trim()) continue;
				let rec: Rec;
				try {
					rec = JSON.parse(line);
				} catch {
					continue;
				}
				this.dispatch(rec);
			}
		}
	}

	private async errLoop() {
		const reader = this.proc.stderr.getReader();
		const dec = new TextDecoder();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			this.stderrText += dec.decode(value, { stream: true });
		}
	}

	wait(pred: (r: Rec) => boolean, timeoutMs = 600_000): Promise<Rec> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				const i = this.waiters.findIndex((w) => w.timer === timer);
				if (i >= 0) this.waiters.splice(i, 1);
				reject(new Error(`timeout after ${timeoutMs}ms waiting for event`));
			}, timeoutMs);
			this.waiters.push({ pred, resolve, reject, timer });
		});
	}

	async send(cmd: Rec) {
		this.proc.stdin.write(`${JSON.stringify(cmd)}\n`);
		await this.proc.stdin.flush();
	}

	async cmd(cmd: Rec, timeoutMs = 120_000): Promise<Rec> {
		const id = cmd.id ?? `c${++this.seq}`;
		const p = this.wait((r) => r.type === "response" && r.id === id, timeoutMs);
		await this.send({ ...cmd, id });
		const resp = await p;
		if (!resp.success) throw new Error(`command ${cmd.type} failed: ${resp.error}`);
		return resp;
	}

	/** 一轮对话：等 agent_settled 为界 */
	async turn(message: string, timeoutMs = 900_000): Promise<void> {
		const id = `p${++this.seq}`;
		const settled = this.wait((r) => r.type === "agent_settled", timeoutMs);
		await this.send({ id, type: "prompt", message });
		const resp: Rec = await this.wait((r) => r.type === "response" && r.id === id, 60_000);
		if (!resp.success) throw new Error(`prompt failed: ${resp.error}`);
		if (resp.data?.disposition === "handled") return;
		await settled;
	}

	async entries(): Promise<Rec[]> {
		return (await this.cmd({ type: "get_entries" })).data.entries;
	}

	async stats(): Promise<Rec> {
		return (await this.cmd({ type: "get_session_stats" })).data;
	}

	async compact(): Promise<Rec> {
		const done = this.wait((r) => r.type === "compaction_end", 300_000);
		const resp = this.cmd({ type: "compact" });
		await resp;
		return await done;
	}

	close() {
		try {
			this.proc.stdin.close();
		} catch {}
	}
}

/** 会话条目 → 纯文本（复刻 pi-recall 的 render，用于核对拼接完整性） */
export const text = (c: unknown): string =>
	typeof c === "string"
		? c
		: Array.isArray(c)
			? c
					.map((p: any) => (p.type === "text" ? p.text : p.type === "image" ? `[image ${String(p.mimeType).replace(/^image\//, "")}]` : ""))
					.filter(Boolean)
					.join("\n")
			: "";

export const render = (msg: any): string => {
	if (!msg) return "";
	if (msg.role === "excluded") return "（这条是 !! 命令，内容被排除在上下文之外，不提供）";
	if (msg.role === "custom") return `[${msg.customType ?? "custom"} notice]\n${text(msg.content)}`;
	if (msg.role === "user") return `[user]\n${text(msg.content)}`;
	if (msg.role === "bashExecution") return `[user] $ ${msg.command}\n${msg.output ?? ""}`;
	if (msg.role === "toolResult") return `[toolResult:${msg.toolName}]\n${text(msg.content)}`;
	if (msg.role === "assistant") {
		const parts: string[] = [];
		for (const p of Array.isArray(msg.content) ? msg.content : []) {
			if (p.type === "text") parts.push(p.text);
			else if (p.type === "thinking") parts.push(`[thinking] ${p.thinking ?? ""}`);
			else if (p.type === "image") parts.push(`[image ${String(p.mimeType).replace(/^image\//, "")}]`);
			else if (p.type === "toolCall") parts.push(`[toolCall:${p.name}] ${JSON.stringify(p.arguments ?? {})}`);
		}
		return `[assistant]\n${parts.join("\n")}`;
	}
	return `[${msg.role}]\n${text(msg.content)}`;
};

/** 消息条目编号：#N = 第 N 个 type==="message" 条目（与 pi-recall 一致） */
export function numberEntries(entries: Rec[]) {
	const msgs: { n: number; entry: Rec; msg: any }[] = [];
	let n = 0;
	for (const e of entries) {
		if (e.type !== "message" || !e.message) continue;
		msgs.push({ n: n++, entry: e, msg: e.message });
	}
	const notices: { n: number; entry: Rec }[] = [];
	for (const e of entries) {
		if (e.type !== "custom_message") continue;
		notices.push({ n: notices.length, entry: e });
	}
	return { msgs, notices };
}
