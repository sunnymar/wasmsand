export interface DnsResolverLike {
  resolve(hostname: string): Promise<string | null>;
}

/**
 * Creates a DNS resolver appropriate for the current runtime:
 *   - Deno: uses Deno.resolveDns('A')
 *   - Node.js: uses node:dns/promises resolve4()
 *   - Browser / other: returns null (no resolver available)
 *
 * Returns null when no resolver is available (e.g. browser).
 * The caller (host_resolve_hostname) maps null → EAI_SYSTEM.
 */
export async function createDnsResolver(): Promise<DnsResolverLike | null> {
  // Deno
  const g = globalThis as Record<string, unknown>;
  if (typeof g['Deno'] === 'object' && g['Deno'] !== null) {
    const deno = g['Deno'] as Record<string, unknown>;
    if (typeof deno['resolveDns'] === 'function') {
      const resolveDns = deno['resolveDns'] as (h: string, t: string) => Promise<string[]>;
      return {
        async resolve(hostname) {
          try {
            const records = await resolveDns(hostname, 'A');
            return records[0] ?? null;
          } catch {
            return null;
          }
        },
      };
    }
  }

  // Node.js
  if (typeof g['process'] === 'object' &&
      (g['process'] as NodeJS.Process)?.versions?.node) {
    try {
      const { resolve4 } = await import('node:dns/promises');
      return {
        async resolve(hostname) {
          try {
            const addrs = await resolve4(hostname);
            return addrs[0] ?? null;
          } catch {
            return null;
          }
        },
      };
    } catch {
      return null;
    }
  }

  return null;
}
