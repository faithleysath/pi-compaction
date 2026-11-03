/**
 * E2E 跑在 bun 下，但仓库的 tsc 只带 @types/node（插件本体是 node 运行时）。
 * 这里只声明 E2E 真正用到的那几个 Bun 全局，避免为了测试给插件加 bun 的运行时依赖。
 */
declare const Bun: {
	which(name: string): string | null;
	sleep(ms: number): Promise<void>;
	spawn(
		cmd: string[],
		opts?: {
			cwd?: string;
			stdin?: "pipe" | "inherit" | "ignore";
			stdout?: "pipe" | "inherit" | "ignore";
			stderr?: "pipe" | "inherit" | "ignore";
			env?: Record<string, string | undefined>;
		},
	): {
		stdin: { write(chunk: string): number; flush(): Promise<void>; close(): void };
		stdout: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }> } };
		stderr: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }> } };
		exited: Promise<number>;
	};
};

interface ImportMeta {
	dir: string;
}
