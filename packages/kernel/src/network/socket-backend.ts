import type { NetworkBridgeLike } from './bridge.js';

export type SocketHandle = number;

export interface SocketPortMapping {
  sandboxHost: '0.0.0.0';
  sandboxPort: number;
  hostPort: number;
}

export interface SocketListenRequest {
  host: '127.0.0.1' | 'localhost' | '0.0.0.0';
  port: number;
  backlog: number;
  mapping?: SocketPortMapping;
}

export interface SocketListenPolicy {
  /**
   * Allow future sandbox-local loopback listeners. This does not expose host
   * ports and is still unsupported until the in-kernel listener registry exists.
   */
  allowLoopback?: boolean;
  /** Explicit host-exposed port mappings, Docker-style. */
  portMappings?: SocketPortMapping[];
  /**
   * Final authorization hook for a future listen() call. Current runtime code
   * stores the hook but still rejects listen because server sockets are deferred.
   */
  onListen?: (request: SocketListenRequest) => boolean | Promise<boolean>;
}

export type SocketBackendResult =
  | { ok: true; data?: string; bytes_sent?: number; data_b64?: string }
  | { ok: false; error: string };

export interface SocketBackend {
  connect(req: { host: string; port: number; tls: boolean }): { ok: true; socket: SocketHandle } | { ok: false; error: string };
  send(socket: SocketHandle, dataB64: string): SocketBackendResult;
  recv(socket: SocketHandle, maxBytes: number): SocketBackendResult;
  setNoDelay?(socket: SocketHandle, enabled: boolean): SocketBackendResult;
  close(socket: SocketHandle): SocketBackendResult;
}

function socketResult(result: { ok: boolean; [key: string]: unknown }): SocketBackendResult {
  if (result.ok) {
    const ok: { ok: true; data?: string; bytes_sent?: number; data_b64?: string } = { ok: true };
    if (typeof result.data === 'string') ok.data = result.data;
    if (typeof result.data_b64 === 'string') ok.data_b64 = result.data_b64;
    if (typeof result.bytes_sent === 'number') ok.bytes_sent = result.bytes_sent;
    return ok;
  }
  return {
    ok: false,
    error: typeof result.error === 'string' ? result.error : 'socket operation failed',
  };
}

export function createNetworkBridgeSocketBackend(bridge: NetworkBridgeLike): SocketBackend {
  return {
    connect(req) {
      const result = bridge.requestSync({
        op: 'connect',
        host: req.host,
        port: req.port,
        tls: req.tls,
      });
      if (!result.ok || typeof result.socket_id !== 'number') {
        return {
          ok: false,
          error: typeof result.error === 'string' ? result.error : 'socket connect failed',
        };
      }
      return { ok: true, socket: result.socket_id };
    },

    send(socket, dataB64) {
      return socketResult(bridge.requestSync({
        op: 'send',
        socket_id: socket,
        data_b64: dataB64,
      }));
    },

    recv(socket, maxBytes) {
      return socketResult(bridge.requestSync({
        op: 'recv',
        socket_id: socket,
        max_bytes: maxBytes,
      }));
    },

    setNoDelay(socket, enabled) {
      return socketResult(bridge.requestSync({
        op: 'set_no_delay',
        socket_id: socket,
        enabled,
      }));
    },

    close(socket) {
      return socketResult(bridge.requestSync({
        op: 'close',
        socket_id: socket,
      }));
    },
  };
}
