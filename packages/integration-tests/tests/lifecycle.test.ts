// packages/integration-tests/tests/lifecycle.test.ts
// Engine-parameterized: set SERVER_BINARY env var to the binary to test.
// Defaults to dist/codepod-server (wasmtime).

import { assertEquals, assertStringIncludes } from "jsr:@std/assert";

const WASM_FIXTURES = new URL(
  "../../orchestrator/src/platform/__tests__/fixtures",
  import.meta.url,
).pathname;

interface RpcResponse {
  jsonrpc: string;
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

interface ServerProcess {
  send(method: string, params?: Record<string, unknown>): Promise<RpcResponse>;
  close(): Promise<void>;
}

async function spawnServer(): Promise<ServerProcess> {
  const binary = Deno.env.get("SERVER_BINARY") ?? "dist/codepod-server";
  const binaryArgs = (Deno.env.get("SERVER_ARGS") ?? "").split(" ").filter(Boolean);

  const proc = new Deno.Command(binary, {
    args: binaryArgs,
    stdin: "piped",
    stdout: "piped",
    stderr: "null",
  }).spawn();

  const writer = proc.stdin.getWriter();
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let nextId = 1;
  const pending = new Map<number, (v: RpcResponse) => void>();

  // Background reader loop — stores the promise so we can await it on close
  const readerDone = (async () => {
    while (true) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch {
        break;
      }
      if (result.done) break;
      buffer += decoder.decode(result.value);
      while (true) {
        const nl = buffer.indexOf("\n");
        if (nl === -1) break;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as RpcResponse;
          // Skip notifications (method present, no response id pairing)
          if ((msg as any).method !== undefined && msg.id === undefined) continue;
          const resolve = pending.get(msg.id as number);
          if (resolve) {
            pending.delete(msg.id as number);
            resolve(msg);
          }
        } catch { /* ignore parse errors */ }
      }
    }
  })();

  return {
    async send(method: string, params: Record<string, unknown> = {}): Promise<RpcResponse> {
      const id = nextId++;
      const req = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
      await writer.write(new TextEncoder().encode(req));
      return new Promise((resolve) => pending.set(id, resolve));
    },
    async close(): Promise<void> {
      // Release the writer lock so the process receives EOF and exits
      try { writer.releaseLock(); } catch { /* ignore */ }
      try { proc.stdin.close(); } catch { /* ignore */ }
      // Kill the process to ensure it exits
      try { proc.kill(); } catch { /* ignore */ }
      // Cancel the reader and wait for the loop to finish
      try { await reader.cancel(); } catch { /* ignore */ }
      await readerDone;
      // Wait for the process to fully exit
      try { await proc.status; } catch { /* ignore */ }
    },
  };
}

async function createSandbox(server: ServerProcess) {
  const resp = await server.send("create", {
    shellWasmPath: `${WASM_FIXTURES}/codepod-shell-exec.wasm`,
    timeoutMs: 30000,
    fsLimitBytes: 64 * 1024 * 1024,
  });
  assertEquals(resp.error, undefined, `create failed: ${JSON.stringify(resp.error)}`);
}

Deno.test("lifecycle: create + run", async () => {
  const server = await spawnServer();
  try {
    await createSandbox(server);
    const ran = await server.send("run", { command: "echo hello-world" });
    assertEquals(ran.error, undefined, `run failed: ${JSON.stringify(ran.error)}`);
    assertStringIncludes((ran.result as any).stdout, "hello-world");
    assertEquals((ran.result as any).exitCode, 0);
  } finally {
    await server.close();
  }
});

Deno.test("lifecycle: files.write + files.read", async () => {
  const server = await spawnServer();
  try {
    await createSandbox(server);
    const content = btoa("hello from test");
    const writeResp = await server.send("files.write", { path: "/tmp/test.txt", data: content });
    assertEquals(writeResp.error, undefined);

    const read = await server.send("files.read", { path: "/tmp/test.txt" });
    assertEquals(read.error, undefined);
    assertEquals(atob((read.result as any).data), "hello from test");
  } finally {
    await server.close();
  }
});

Deno.test("lifecycle: snapshot.create + snapshot.restore", async () => {
  const server = await spawnServer();
  try {
    await createSandbox(server);
    await server.send("files.write", { path: "/tmp/before.txt", data: btoa("before") });
    const snap = await server.send("snapshot.create", {});
    assertEquals(snap.error, undefined);
    const snapId = (snap.result as any).id;

    await server.send("files.write", { path: "/tmp/after.txt", data: btoa("after") });
    await server.send("snapshot.restore", { id: snapId });

    // before.txt should still exist
    const r = await server.send("files.read", { path: "/tmp/before.txt" });
    assertEquals(r.error, undefined);
    assertEquals(atob((r.result as any).data), "before");

    // after.txt should be gone
    const r2 = await server.send("files.read", { path: "/tmp/after.txt" });
    assertEquals(r2.error != null, true, "expected error for missing file");
  } finally {
    await server.close();
  }
});

Deno.test("lifecycle: persistence.export + import", async () => {
  const server = await spawnServer();
  try {
    await createSandbox(server);
    await server.send("files.write", { path: "/tmp/data.txt", data: btoa("persisted") });
    const exported = await server.send("persistence.export", {});
    assertEquals(exported.error, undefined);
    const blob = (exported.result as any).data as string;
    assertEquals(typeof blob, "string");

    // Overwrite the file
    await server.send("files.write", { path: "/tmp/data.txt", data: btoa("overwritten") });

    // Import the state
    await server.send("persistence.import", { data: blob });

    // Should be restored
    const r = await server.send("files.read", { path: "/tmp/data.txt" });
    assertEquals(r.error, undefined);
    assertEquals(atob((r.result as any).data), "persisted");
  } finally {
    await server.close();
  }
});

Deno.test("lifecycle: env.set + env.get", async () => {
  const server = await spawnServer();
  try {
    await createSandbox(server);
    await server.send("env.set", { name: "MY_VAR", value: "hello" });
    const got = await server.send("env.get", { name: "MY_VAR" });
    assertEquals(got.error, undefined);
    assertEquals((got.result as any).value, "hello");
  } finally {
    await server.close();
  }
});
