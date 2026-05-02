import { assertEquals, assertRejects, assertStrictEquals } from "jsr:@std/assert@^1.0.19";
import { MemoryWasmModuleCache, sha256Hex } from "../module-cache.ts";

const emptyModule = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d,
  0x01, 0x00, 0x00, 0x00,
]);

Deno.test("MemoryWasmModuleCache compiles once per digest", async () => {
  let calls = 0;
  const cache = new MemoryWasmModuleCache(async () => {
    calls++;
    return await WebAssembly.compile(emptyModule);
  });

  const first = await cache.getOrCompile("abc", emptyModule);
  const second = await cache.getOrCompile("abc", emptyModule);

  assertStrictEquals(first, second);
  assertEquals(calls, 1);
  assertEquals(cache.stats(), { modules: 1 });
});

Deno.test("MemoryWasmModuleCache uses digest rather than object identity", async () => {
  const cache = new MemoryWasmModuleCache();
  const first = await cache.getOrCompile("digest", emptyModule);
  const second = await cache.getOrCompile("digest", new Uint8Array(emptyModule));
  assertStrictEquals(first, second);
});

Deno.test("MemoryWasmModuleCache retries after a rejected compile", async () => {
  let calls = 0;
  const cache = new MemoryWasmModuleCache(async () => {
    calls++;
    if (calls === 1) throw new Error("compile failed");
    return await WebAssembly.compile(emptyModule);
  });

  await assertRejects(
    () => cache.getOrCompile("retry", emptyModule),
    Error,
    "compile failed",
  );
  await cache.getOrCompile("retry", emptyModule);

  assertEquals(calls, 2);
  assertEquals(cache.stats(), { modules: 1 });
});

Deno.test("sha256Hex computes stable SHA-256 hex digests", async () => {
  assertEquals(
    await sha256Hex(new TextEncoder().encode("abc")),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});
