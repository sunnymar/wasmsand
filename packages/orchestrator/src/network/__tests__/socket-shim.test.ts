import { describe, it, expect } from 'bun:test';
import { SOCKET_SHIM_SOURCE, SITE_CUSTOMIZE_SOURCE } from '../socket-shim.js';

describe('socket shim source', () => {
  it('exports a non-empty Python source string', () => {
    expect(typeof SOCKET_SHIM_SOURCE).toBe('string');
    expect(SOCKET_SHIM_SOURCE.length).toBeGreaterThan(100);
  });

  it('contains the required socket API surface', () => {
    expect(SOCKET_SHIM_SOURCE).toContain('class socket:');
    expect(SOCKET_SHIM_SOURCE).toContain('def connect(');
    expect(SOCKET_SHIM_SOURCE).toContain('def send(');
    expect(SOCKET_SHIM_SOURCE).toContain('def sendall(');
    expect(SOCKET_SHIM_SOURCE).toContain('def recv(');
    expect(SOCKET_SHIM_SOURCE).toContain('def makefile(');
    expect(SOCKET_SHIM_SOURCE).toContain('def close(');
    expect(SOCKET_SHIM_SOURCE).toContain('def create_connection(');
    expect(SOCKET_SHIM_SOURCE).toContain('def getaddrinfo(');
    expect(SOCKET_SHIM_SOURCE).toContain('CONTROL_FD');
    expect(SOCKET_SHIM_SOURCE).toContain('CONTROL_FD = 1023');
  });

  it('contains Content-Length aware flush logic', () => {
    expect(SOCKET_SHIM_SOURCE).toContain('content-length');
    expect(SOCKET_SHIM_SOURCE).toContain('_should_flush');
  });

  it('exports SITE_CUSTOMIZE_SOURCE that injects socket into sys.modules', () => {
    expect(typeof SITE_CUSTOMIZE_SOURCE).toBe('string');
    expect(SITE_CUSTOMIZE_SOURCE).toContain('sys.modules["socket"]');
  });
});
