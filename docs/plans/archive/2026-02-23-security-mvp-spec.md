# Security MVP Spec

## Goal

Define the minimum security baseline required to run untrusted or semi-trusted LLM-generated code in wasmsand.

This MVP is intentionally narrow: make denial-of-service and capability-escape failures significantly harder, provide clear policy controls, and add auditability.

## Scope

In scope:
- Hard execution cancellation and cleanup
- Capability policy enforcement (network + host mounts + tool allowlist)
- Resource quotas and output limits
- Tenant/session isolation model
- Security logging and test coverage

Out of scope:
- Full multi-tenant distributed scheduler
- User authn/authz product surface
- Formal verification

## Threat Model

Assume attacker controls command text and file contents executed in sandbox.

Primary risks:
1. Compute denial of service: infinite loops, runaway output, memory pressure.
2. Data exfiltration: unauthorized network egress or host file access.
3. Cross-session leakage: one sandbox reads state from another.
4. Host impact: sandbox hangs host process or degrades service quality.

Non-goal for MVP:
- Prevent all side channels (timing, microarchitectural).

## Security Requirements

### R1. Hard Kill Semantics (P0)

`timeoutMs` must terminate execution, not only return early.

Required behavior:
- Timeout or explicit cancel always stops currently running command.
- Cancel returns deterministic error code and reason (`TIMEOUT` or `CANCELLED`).
- No leaked child worker/process after cancel.

Implementation direction:
- Run execution loop in isolated worker/process boundary.
- On timeout/cancel, terminate worker/process and recreate clean executor.

Initial file targets:
- `packages/orchestrator/src/sandbox.ts`
- `packages/orchestrator/src/process/manager.ts`
- `packages/sdk-server/src/dispatcher.ts`
- `packages/python-sdk/src/wasmsand/commands.py`

### R2. Capability Policy (P0)

Default-deny capabilities, explicit allow only.

Policy dimensions:
- `network`: off by default; optional domain allowlist.
- `host_mounts`: explicit mount points, each with read-only/read-write mode.
- `tools`: optional allowlist of executable tool names.

Required behavior:
- Disallowed capability usage fails with stable error class (`E_CAPABILITY_DENIED`).
- Policies are immutable for the life of a sandbox session.

Initial file targets:
- `packages/orchestrator/src/sandbox.ts` (new options surface)
- `packages/orchestrator/src/wasi/wasi-host.ts` (enforcement points)
- `packages/orchestrator/src/wasi/types.ts`
- `packages/sdk-server/src/server.ts` and `packages/sdk-server/src/dispatcher.ts`

### R3. Quotas and Limits (P0)

Enforce multi-dimensional limits:
- Wall time per command
- Memory limit per execution
- VFS bytes (already present), plus max file count
- Stdout/stderr max bytes with truncation marker
- Max command length and max RPC payload size

Required behavior:
- Limit violations are deterministic and machine-readable (`E_LIMIT_*`).
- Output truncation is explicit in structured response.

Initial file targets:
- `packages/orchestrator/src/sandbox.ts`
- `packages/orchestrator/src/wasi/wasi-host.ts`
- `packages/sdk-server/src/server.ts`
- `packages/sdk-server/src/dispatcher.ts`

### R4. Isolation Model (P0)

One sandbox session per isolated executor boundary.

Required behavior:
- No global mutable state shared between sessions.
- Session destroy guarantees memory/file state is no longer reachable.
- Python SDK and server use independent sandbox instance per session.

Initial file targets:
- `packages/sdk-server/src/server.ts`
- `packages/python-sdk/src/wasmsand/_rpc.py`
- `packages/python-sdk/src/wasmsand/sandbox.py`

### R5. Security Telemetry (P1)

Emit structured audit events for security-relevant actions.

Event classes:
- Command started/completed (with session id)
- Timeout/cancel
- Capability denied
- Limit exceeded
- Sandbox create/destroy

Requirements:
- Events go to stderr/log sink, never mixed into stdout RPC channel.
- Include stable event type and key fields (`session_id`, `command_id`, `reason`).

Initial file targets:
- `packages/sdk-server/src/server.ts`
- `packages/sdk-server/src/dispatcher.ts`
- `packages/orchestrator/src/sandbox.ts`

## API Surface (MVP)

Add `security` block to sandbox creation options:

```ts
interface SecurityOptions {
  network?: {
    enabled: boolean;
    allowDomains?: string[];
  };
  hostMounts?: Array<{
    hostPath: string;
    sandboxPath: string;
    mode: 'ro' | 'rw';
  }>;
  toolAllowlist?: string[];
  limits?: {
    timeoutMs?: number;
    memoryBytes?: number;
    fsBytes?: number;
    fileCount?: number;
    stdoutBytes?: number;
    stderrBytes?: number;
    commandBytes?: number;
    rpcBytes?: number;
  };
}
```

Run result envelope extension:

```ts
interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  executionTimeMs: number;
  truncated?: {
    stdout: boolean;
    stderr: boolean;
  };
  errorClass?: 'TIMEOUT' | 'CANCELLED' | 'CAPABILITY_DENIED' | 'LIMIT_EXCEEDED';
}
```

## Implementation Plan

### Phase 1: Control Plane Hardening (P0)

1. Introduce immutable `SecurityOptions` on create.
2. Lower RPC max request size from 400MB to safer default.
3. Enforce command/RPC/output size caps in dispatcher/server.
4. Add structured error classes and stable codes.

### Phase 2: Execution Safety (P0)

1. Move execution to killable boundary (worker/process).
2. Implement hard timeout and explicit cancel RPC method.
3. Ensure cleanup and executor restart after kill.

### Phase 3: Capability Enforcement (P0)

1. Implement deny-by-default network path.
2. Add host mount policy and mode checks.
3. Add tool allowlist checks before spawn.

### Phase 4: Observability and Tests (P1)

1. Add structured security event logging.
2. Add integration tests for each deny/limit path.
3. Add fuzz/smoke tests for parser + shell command stress.

## Acceptance Criteria

Security MVP is complete when all are true:
1. Infinite loop command is terminated by hard timeout and does not continue running.
2. Disallowed network attempt returns capability-denied error.
3. Disallowed host path access is denied.
4. Stdout flood is truncated at configured cap with explicit truncation metadata.
5. RPC oversized request is rejected before parse/execute.
6. Two concurrent sessions cannot read each other's file state.
7. Audit logs include timeout, deny, and limit events with stable schema.

## Test Matrix

Required tests:
- Unit: limit check helpers and policy evaluators.
- Integration: SDK server create/run/cancel/destroy lifecycle.
- Adversarial:
  - `yes | cat` flood
  - infinite python loop
  - large command payload
  - path traversal attempts on mounts
  - repeated create/destroy stress

Initial test file targets:
- `packages/orchestrator/src/__tests__/sandbox.test.ts`
- `packages/orchestrator/src/python/__tests__/python-runner.test.ts`
- `packages/sdk-server/src/server.test.ts`
- `packages/sdk-server/src/dispatcher.test.ts`

## Default Secure Configuration

Recommended defaults for first production release:
- Network disabled
- No host mounts
- Tool allowlist set to curated core tools + python3
- `timeoutMs=10_000`
- `memoryBytes=256MB`
- `fsBytes=256MB`
- `stdoutBytes=1MB`
- `stderrBytes=1MB`
- `commandBytes=64KB`
- `rpcBytes=8MB`

## Open Decisions

1. Worker model choice for Node path (Worker Threads vs child process).
2. Browser model parity for hard timeout behavior.
3. Whether to support mutable per-command policy overrides (default: no).

