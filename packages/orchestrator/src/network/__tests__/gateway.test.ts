import { describe, it, expect, mock } from 'bun:test';
import { NetworkGateway, NetworkAccessDenied } from '../gateway.js';
import type { NetworkPolicy } from '../gateway.js';
import { matchesHostList, HOST_MATCH_SOURCE } from '../host-match.js';

describe('NetworkGateway', () => {
  describe('checkAccess', () => {
    it('blocks all requests when no policy lists are set', () => {
      const gw = new NetworkGateway({});
      const result = gw.checkAccess('https://example.com', 'GET');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('no network policy');
    });

    it('allows requests to allowedHosts', () => {
      const gw = new NetworkGateway({ allowedHosts: ['example.com'] });
      expect(gw.checkAccess('https://example.com/api', 'GET').allowed).toBe(true);
    });

    it('blocks requests to hosts not in allowedHosts', () => {
      const gw = new NetworkGateway({ allowedHosts: ['example.com'] });
      expect(gw.checkAccess('https://evil.com', 'GET').allowed).toBe(false);
    });

    it('supports wildcard in allowedHosts', () => {
      const gw = new NetworkGateway({ allowedHosts: ['*.example.com'] });
      expect(gw.checkAccess('https://api.example.com/data', 'GET').allowed).toBe(true);
      expect(gw.checkAccess('https://example.com', 'GET').allowed).toBe(false);
    });

    it('supports bare * wildcard to allow all hosts', () => {
      const gw = new NetworkGateway({ allowedHosts: ['*'] });
      expect(gw.checkAccess('https://anything.example.com', 'GET').allowed).toBe(true);
      expect(gw.checkAccess('https://evil.com', 'GET').allowed).toBe(true);
    });

    it('blockedHosts blocks specific hosts', () => {
      const gw = new NetworkGateway({ blockedHosts: ['evil.com'] });
      expect(gw.checkAccess('https://evil.com', 'GET').allowed).toBe(false);
      expect(gw.checkAccess('https://good.com', 'GET').allowed).toBe(true);
    });

    it('allowedHosts takes precedence over blockedHosts', () => {
      const gw = new NetworkGateway({
        allowedHosts: ['example.com'],
        blockedHosts: ['example.com'],
      });
      expect(gw.checkAccess('https://example.com', 'GET').allowed).toBe(true);
    });
  });

  describe('fetch', () => {
    it('throws NetworkAccessDenied when access is blocked', async () => {
      const gw = new NetworkGateway({});
      try {
        await gw.fetch('https://example.com');
        expect(true).toBe(false); // should not reach
      } catch (err) {
        expect(err).toBeInstanceOf(NetworkAccessDenied);
      }
    });

    it('calls onRequest callback after static checks pass', async () => {
      const onRequest = mock(async () => false);
      const gw = new NetworkGateway({
        allowedHosts: ['example.com'],
        onRequest,
      });
      try {
        await gw.fetch('https://example.com');
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(NetworkAccessDenied);
      }
      expect(onRequest).toHaveBeenCalledWith(expect.objectContaining({
        url: 'https://example.com',
        method: 'GET',
      }));
    });

    it('proceeds when onRequest returns true', async () => {
      const onRequest = mock(async () => true);
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(async () => new Response('ok'));
      try {
        const gw = new NetworkGateway({
          allowedHosts: ['example.com'],
          onRequest,
        });
        const resp = await gw.fetch('https://example.com');
        expect(await resp.text()).toBe('ok');
        expect(globalThis.fetch).toHaveBeenCalled();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});

describe('matchesHostList', () => {
  it('matches exact host', () => {
    expect(matchesHostList('example.com', ['example.com'])).toBe(true);
  });

  it('does not match different host', () => {
    expect(matchesHostList('evil.com', ['example.com'])).toBe(false);
  });

  it('matches wildcard subdomain', () => {
    expect(matchesHostList('api.example.com', ['*.example.com'])).toBe(true);
  });

  it('wildcard does not match the base domain itself', () => {
    expect(matchesHostList('example.com', ['*.example.com'])).toBe(false);
  });

  it('bare * matches any host', () => {
    expect(matchesHostList('anything.example.com', ['*'])).toBe(true);
    expect(matchesHostList('evil.com', ['*'])).toBe(true);
  });

  it('matches deep subdomain with wildcard', () => {
    expect(matchesHostList('deep.sub.example.com', ['*.example.com'])).toBe(true);
  });

  it('does not match partial suffix', () => {
    expect(matchesHostList('notexample.com', ['*.example.com'])).toBe(false);
  });

  it('HOST_MATCH_SOURCE contains the same logic as matchesHostList', () => {
    // Verify the source string contains the key patterns
    expect(HOST_MATCH_SOURCE).toContain("pattern === '*'");
    expect(HOST_MATCH_SOURCE).toContain("pattern.startsWith('*.')");
    expect(HOST_MATCH_SOURCE).toContain('host === pattern');
  });
});
