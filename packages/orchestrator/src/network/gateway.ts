/**
 * NetworkGateway: policy enforcement layer for all sandbox network access.
 *
 * Checks requests against allowedHosts/blockedHosts lists and an optional
 * async callback before delegating to the host fetch() API. Used by shell
 * builtins (curl, wget) and the WASI socket bridge.
 */

export interface NetworkPolicy {
  /** Whitelist mode: only these hosts allowed. Supports wildcards (*.example.com). */
  allowedHosts?: string[];
  /** Blacklist mode: these hosts blocked. Ignored if allowedHosts is set. */
  blockedHosts?: string[];
  /** Async callback for dynamic allow/deny. Called after static checks pass. */
  onRequest?: (request: {
    url: string;
    method: string;
    headers: Record<string, string>;
  }) => Promise<boolean>;
}

export class NetworkAccessDenied extends Error {
  constructor(url: string, reason: string) {
    super(`Network access denied for ${url}: ${reason}`);
    this.name = 'NetworkAccessDenied';
  }
}

export class NetworkGateway {
  private policy: NetworkPolicy;

  constructor(policy: NetworkPolicy) {
    this.policy = policy;
  }

  /** Synchronous check against allow/block lists. */
  checkAccess(url: string, method: string): { allowed: boolean; reason?: string } {
    const host = this.extractHost(url);
    if (host === null) {
      return { allowed: false, reason: 'invalid URL' };
    }

    const { allowedHosts, blockedHosts } = this.policy;

    // If allowedHosts is set, use whitelist mode
    if (allowedHosts !== undefined) {
      if (this.matchesHostList(host, allowedHosts)) {
        return { allowed: true };
      }
      return { allowed: false, reason: `host ${host} not in allowedHosts` };
    }

    // If blockedHosts is set, use blacklist mode
    if (blockedHosts !== undefined) {
      if (this.matchesHostList(host, blockedHosts)) {
        return { allowed: false, reason: `host ${host} is in blockedHosts` };
      }
      return { allowed: true };
    }

    // Neither list set: block all (safe default)
    return { allowed: false, reason: 'no network policy configured (default deny)' };
  }

  /** Fetch with policy enforcement. Throws NetworkAccessDenied on denial. */
  async fetch(url: string, options?: RequestInit): Promise<Response> {
    const method = options?.method ?? 'GET';
    const headers: Record<string, string> = {};
    if (options?.headers) {
      const h = options.headers;
      if (h instanceof Headers) {
        h.forEach((v, k) => {
          headers[k] = v;
        });
      } else if (Array.isArray(h)) {
        for (const [k, v] of h) {
          headers[k] = v;
        }
      } else {
        Object.assign(headers, h);
      }
    }

    // Static check
    const access = this.checkAccess(url, method);
    if (!access.allowed) {
      throw new NetworkAccessDenied(url, access.reason!);
    }

    // Dynamic callback check
    if (this.policy.onRequest) {
      const allowed = await this.policy.onRequest({ url, method, headers });
      if (!allowed) {
        throw new NetworkAccessDenied(url, 'denied by onRequest callback');
      }
    }

    return globalThis.fetch(url, options);
  }

  private extractHost(url: string): string | null {
    try {
      return new URL(url).hostname;
    } catch {
      return null;
    }
  }

  private matchesHostList(host: string, list: string[]): boolean {
    for (const pattern of list) {
      if (pattern.startsWith('*.')) {
        const suffix = pattern.slice(2);
        if (
          host.endsWith(suffix) &&
          host.length > suffix.length &&
          host[host.length - suffix.length - 1] === '.'
        ) {
          return true;
        }
      } else if (host === pattern) {
        return true;
      }
    }
    return false;
  }
}
