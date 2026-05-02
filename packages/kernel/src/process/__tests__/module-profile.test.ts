import { assertEquals, assertThrows } from "jsr:@std/assert@^1.0.19";
import {
  analyzeCodepodModule,
  validateCodepodModuleProfile,
} from "../module-profile.ts";

function encodeU32(value: number): number[] {
  const out: number[] = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value !== 0) byte |= 0x80;
    out.push(byte);
  } while (value !== 0);
  return out;
}

function bytes(value: string): number[] {
  return [...new TextEncoder().encode(value)];
}

function vec(items: number[][]): number[] {
  return [...encodeU32(items.length), ...items.flat()];
}

function section(id: number, payload: number[]): number[] {
  return [id, ...encodeU32(payload.length), ...payload];
}

function customSection(name: string, payload: string): number[] {
  const body = [...encodeU32(name.length), ...bytes(name), ...bytes(payload)];
  return section(0, body);
}

function makeModule(opts: {
  imports?: string[];
  features?: string[];
  asyncify?: boolean;
}): WebAssembly.Module {
  const imports = opts.imports ?? [];
  const asyncifyExports = opts.asyncify
    ? [
      "asyncify_start_unwind",
      "asyncify_stop_unwind",
      "asyncify_start_rewind",
      "asyncify_stop_rewind",
      "asyncify_get_state",
    ]
    : [];

  const typeSection = section(1, vec([[0x60, 0x00, 0x00]]));
  const importSection = imports.length === 0
    ? []
    : section(
      2,
      vec(imports.map((name) => [
        ...encodeU32("codepod".length),
        ...bytes("codepod"),
        ...encodeU32(name.length),
        ...bytes(name),
        0x00,
        0x00,
      ])),
    );
  const functionSection = asyncifyExports.length === 0
    ? []
    : section(3, vec(asyncifyExports.map(() => [0x00])));
  const exportSection = asyncifyExports.length === 0
    ? []
    : section(
      7,
      vec(asyncifyExports.map((name, index) => [
        ...encodeU32(name.length),
        ...bytes(name),
        0x00,
        ...encodeU32(imports.length + index),
      ])),
    );
  const codeSection = asyncifyExports.length === 0
    ? []
    : section(10, vec(asyncifyExports.map(() => [0x02, 0x00, 0x0b])));
  const featureSection = opts.features
    ? customSection(
      "codepod.features",
      JSON.stringify({ async: "asyncify", features: opts.features }),
    )
    : [];

  return new WebAssembly.Module(new Uint8Array([
    0x00,
    0x61,
    0x73,
    0x6d,
    0x01,
    0x00,
    0x00,
    0x00,
    ...featureSection,
    ...typeSection,
    ...importSection,
    ...functionSection,
    ...exportSection,
    ...codeSection,
  ]));
}

Deno.test("host_setjmp imports require continuation metadata", () => {
  const module = makeModule({ imports: ["host_setjmp", "host_longjmp"], asyncify: true });

  assertThrows(
    () => validateCodepodModuleProfile(analyzeCodepodModule(module)),
    Error,
    "module imports host_setjmp/host_longjmp but lacks codepod.features continuations marker",
  );
});

Deno.test("host_fork imports require continuation metadata", () => {
  const module = makeModule({ imports: ["host_fork"], asyncify: true });

  assertThrows(
    () => validateCodepodModuleProfile(analyzeCodepodModule(module)),
    Error,
    "module imports host_fork but lacks codepod.features continuations marker",
  );
});

Deno.test("continuation metadata requires asyncify exports", () => {
  const module = makeModule({ features: ["continuations"] });

  assertThrows(
    () => validateCodepodModuleProfile(analyzeCodepodModule(module)),
    Error,
    "module declares codepod.features continuations but is not asyncify-instrumented",
  );
});

Deno.test("legacy setjmp feature is accepted as continuation metadata", () => {
  const module = makeModule({
    imports: ["host_setjmp", "host_longjmp"],
    features: ["setjmp"],
    asyncify: true,
  });

  const profile = validateCodepodModuleProfile(analyzeCodepodModule(module));

  assertEquals(profile.requiresContinuations, true);
  assertEquals(profile.bridge, "asyncify");
});

Deno.test("continuation modules choose asyncify even when JSPI exists", () => {
  const module = makeModule({
    imports: ["host_fork"],
    features: ["continuations"],
    asyncify: true,
  });

  const profile = validateCodepodModuleProfile(analyzeCodepodModule(module, {
    jspiAvailable: true,
  }));

  assertEquals(profile.requiresContinuations, true);
  assertEquals(profile.bridge, "asyncify");
});

Deno.test("plain modules choose JSPI when available", () => {
  const module = makeModule({});

  const profile = validateCodepodModuleProfile(analyzeCodepodModule(module, {
    jspiAvailable: true,
  }));

  assertEquals(profile.requiresContinuations, false);
  assertEquals(profile.bridge, "jspi");
});
