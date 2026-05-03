/* Networking name-resolution shims.
 *
 * wasi-libc has no <netdb.h>: gethostbyname/getaddrinfo all expect a
 * resolver. Codepod routes hostname resolution through the kernel via
 * host_resolve_hostname, which does real DNS on the server side and
 * returns EAI_SYSTEM on browser (where no resolver is available). */

#include <arpa/inet.h>
#include <errno.h>
#include <netdb.h>
#include <stdio.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

#include "codepod_runtime.h"

int h_errno = 1;  /* HOST_NOT_FOUND */

char *hstrerror(int err) {
    /* Non-const return matches glibc's historical signature (BusyBox etc.). */
    switch (err) {
        case 1: return (char *)"Host not found";
        case 2: return (char *)"Try again";
        case 3: return (char *)"Non-recoverable error";
        case 4: return (char *)"No address";
        default: return (char *)"Unknown host error";
    }
}

struct netent *getnetbyname(const char *name) {
    (void)name;
    return NULL;
}

struct netent *getnetbyaddr(uint32_t net, int type) {
    (void)net; (void)type;
    return NULL;
}

struct servent *getservbyname(const char *name, const char *proto) {
    (void)name; (void)proto;
    return NULL;
}

struct servent *getservbyport(int port, const char *proto) {
    (void)port; (void)proto;
    return NULL;
}

/* ── Address ↔ hostname mapping table ─────────────────────────────────────
 *
 * Populated by getaddrinfo/gethostbyname when the kernel resolves a name.
 * Used by getnameinfo and connect() to recover the original hostname from
 * a resolved address (necessary for TLS SNI at the sandbox boundary). */

#define CODEPOD_ADDRMAP_SIZE 32

static struct {
    uint32_t addr_be;       /* network byte order */
    char host[256];
} codepod_addrmap[CODEPOD_ADDRMAP_SIZE];
static int codepod_addrmap_count = 0;   /* slots filled so far, capped at SIZE */
static int codepod_addrmap_cursor = 0;  /* next eviction slot once table is full */

static void codepod_addrmap_store(const char *host, uint32_t addr_be) {
    /* Check for an existing entry for this (host, addr) pair. */
    for (int i = 0; i < codepod_addrmap_count; i++) {
        if (strcmp(codepod_addrmap[i].host, host) == 0 &&
            codepod_addrmap[i].addr_be == addr_be)
            return;  /* already recorded, nothing to do */
        /* Do NOT overwrite a different host that happens to share the same
         * IP (CDN / shared hosting).  The first host to claim an address
         * keeps it for reverse lookup; later hosts with the same IP are
         * stored in their own slot so forward lookup still works. */
    }
    int slot;
    if (codepod_addrmap_count < CODEPOD_ADDRMAP_SIZE) {
        slot = codepod_addrmap_count++;
    } else {
        /* Table is full: use a rotating cursor so eviction spreads evenly
         * across all slots rather than always clobbering slot 0. */
        slot = codepod_addrmap_cursor;
        codepod_addrmap_cursor = (codepod_addrmap_cursor + 1) % CODEPOD_ADDRMAP_SIZE;
    }
    snprintf(codepod_addrmap[slot].host, sizeof(codepod_addrmap[slot].host), "%s", host);
    codepod_addrmap[slot].addr_be = addr_be;
}

const char *codepod_netdb_host_for_addr(uint32_t addr_be) {
    if (addr_be == htonl(0x7f000001u)) return "127.0.0.1";
    for (int i = 0; i < codepod_addrmap_count; i++) {
        if (codepod_addrmap[i].addr_be == addr_be)
            return codepod_addrmap[i].host;
    }
    return NULL;
}

/* Resolve a hostname to an IPv4 address via the kernel, caching the result.
 * Returns 0 on failure (also sets a best-effort EAI code in *eai_out if
 * eai_out is non-NULL). */
static uint32_t codepod_resolve_and_cache(const char *host, int *eai_out) {
    /* Check cache first. */
    for (int i = 0; i < codepod_addrmap_count; i++) {
        if (strcmp(codepod_addrmap[i].host, host) == 0) {
            if (eai_out) *eai_out = 0;
            return codepod_addrmap[i].addr_be;
        }
    }

    char ip_buf[INET_ADDRSTRLEN];
    int n = codepod_host_resolve_hostname(
        (int)(intptr_t)host, (int)strlen(host),
        (int)(intptr_t)ip_buf, (int)(sizeof(ip_buf) - 1)
    );
    if (n < 0) {
        if (eai_out) *eai_out = n;  /* n is EAI_* */
        return 0;
    }
    if (n == 0 || n >= (int)sizeof(ip_buf)) {
        if (eai_out) *eai_out = EAI_NONAME;
        return 0;
    }
    ip_buf[n] = '\0';

    struct in_addr in;
    if (inet_pton(AF_INET, ip_buf, &in) != 1) {
        if (eai_out) *eai_out = EAI_NONAME;
        return 0;
    }

    codepod_addrmap_store(host, in.s_addr);
    if (eai_out) *eai_out = 0;
    return in.s_addr;
}

uint32_t codepod_netdb_addr_for_host(const char *host) {
    if (!host || !*host) return 0;
    if (strcmp(host, "localhost") == 0) return htonl(0x7f000001u);
    return codepod_resolve_and_cache(host, NULL);
}

/* ── gethostbyname static storage ─────────────────────────────────────────*/

static struct hostent codepod_hostent;
static char *codepod_hostent_addr_list[2];
static uint32_t codepod_hostent_addr_be;
static char codepod_hostent_name[256];

struct hostent *gethostbyname(const char *name) {
    if (!name || !*name) {
        h_errno = HOST_NOT_FOUND;
        return NULL;
    }

    uint32_t addr_be;
    if (strcmp(name, "localhost") == 0) {
        addr_be = htonl(0x7f000001u);
    } else {
        struct in_addr parsed;
        if (inet_pton(AF_INET, name, &parsed) == 1) {
            addr_be = parsed.s_addr;
        } else {
            int eai = 0;
            addr_be = codepod_resolve_and_cache(name, &eai);
            if (addr_be == 0) {
                h_errno = HOST_NOT_FOUND;
                return NULL;
            }
        }
    }

    snprintf(codepod_hostent_name, sizeof(codepod_hostent_name), "%s", name);
    codepod_hostent_addr_be = addr_be;
    codepod_hostent_addr_list[0] = (char *)&codepod_hostent_addr_be;
    codepod_hostent_addr_list[1] = NULL;
    codepod_hostent.h_name      = codepod_hostent_name;
    codepod_hostent.h_aliases   = NULL;
    codepod_hostent.h_addrtype  = AF_INET;
    codepod_hostent.h_length    = 4;
    codepod_hostent.h_addr_list = codepod_hostent_addr_list;
    h_errno = 0;
    return &codepod_hostent;
}

/* ── getaddrinfo ───────────────────────────────────────────────────────────*/

static struct sockaddr_in codepod_ai_addr;
static struct addrinfo codepod_ai;
static char codepod_ai_canonname[256];

/* Returns 1 if service is a pure decimal port number, 0 otherwise. */
static int service_is_numeric(const char *service) {
    if (!service || !*service) return 0;
    for (const char *p = service; *p; ++p)
        if (*p < '0' || *p > '9') return 0;
    return 1;
}

static uint16_t parse_service_port(const char *service) {
    if (!service_is_numeric(service)) return 0;
    unsigned long port = 0;
    for (const char *p = service; *p; ++p) {
        unsigned long digit = (unsigned long)(*p - '0');
        /* Guard before multiplying: if port > (65535 - digit) / 10 then
         * port * 10 + digit > 65535, regardless of unsigned long width. */
        if (port > (65535UL - digit) / 10UL) return 0;
        port = port * 10UL + digit;
    }
    return (uint16_t)port;
}

int getaddrinfo(const char *node, const char *service,
                const struct addrinfo *hints, struct addrinfo **res) {
    if (!res) return EAI_NONAME;
    *res = NULL;

    int family = hints ? hints->ai_family : AF_INET;
    if (family != AF_UNSPEC && family != AF_INET) return EAI_FAMILY;

    const char *host = (node && *node) ? node : NULL;

    memset(&codepod_ai_addr, 0, sizeof(codepod_ai_addr));
    codepod_ai_addr.sin_family = AF_INET;
    codepod_ai_addr.sin_port   = htons(parse_service_port(service));

    int numeric_host = hints && (hints->ai_flags & AI_NUMERICHOST);
    int numeric_serv = hints && (hints->ai_flags & AI_NUMERICSERV);

    if (numeric_serv && service && *service && !service_is_numeric(service))
        return EAI_SERVICE;

    if (!host) {
        codepod_ai_addr.sin_addr.s_addr = INADDR_ANY;
    } else if (strcmp(host, "localhost") == 0) {
        if (numeric_host) return EAI_NONAME;
        codepod_ai_addr.sin_addr.s_addr = htonl(0x7f000001u);
    } else if (inet_pton(AF_INET, host, &codepod_ai_addr.sin_addr) == 1) {
        /* already a numeric address — always accepted */
    } else {
        if (numeric_host) return EAI_NONAME;
        int eai = 0;
        uint32_t addr_be = codepod_resolve_and_cache(host, &eai);
        if (addr_be == 0) return eai ? eai : EAI_NONAME;
        codepod_ai_addr.sin_addr.s_addr = addr_be;
    }

    memset(&codepod_ai, 0, sizeof(codepod_ai));
    codepod_ai.ai_family   = AF_INET;
    codepod_ai.ai_socktype = hints ? hints->ai_socktype : 0;
    codepod_ai.ai_protocol = hints ? hints->ai_protocol : 0;
    codepod_ai.ai_addrlen  = sizeof(codepod_ai_addr);
    codepod_ai.ai_addr     = (struct sockaddr *)&codepod_ai_addr;
    if (hints && (hints->ai_flags & AI_CANONNAME)) {
        snprintf(codepod_ai_canonname, sizeof(codepod_ai_canonname), "%s",
                 host ? host : "0.0.0.0");
        codepod_ai.ai_canonname = codepod_ai_canonname;
    }
    *res = &codepod_ai;
    return 0;
}

void freeaddrinfo(struct addrinfo *res) {
    (void)res;
}

const char *gai_strerror(int errcode) {
    switch (errcode) {
        case 0:              return "Success";
        case EAI_BADFLAGS:   return "Bad value for ai_flags";
        case EAI_NONAME:     return "Name or service not known";
        case EAI_AGAIN:      return "Temporary failure in name resolution";
        case EAI_FAIL:       return "Non-recoverable failure in name resolution";
        case EAI_FAMILY:     return "Address family not supported";
        case EAI_SOCKTYPE:   return "Socket type not supported";
        case EAI_SERVICE:    return "Service not supported";
        case EAI_MEMORY:     return "Memory allocation failure";
        case EAI_SYSTEM:     return "System error";
        case EAI_OVERFLOW:   return "Argument buffer overflow";
        default:             return "Unknown getaddrinfo error";
    }
}

int getnameinfo(const struct sockaddr *addr, socklen_t addrlen,
                char *host, socklen_t hostlen,
                char *serv, socklen_t servlen, int flags) {
    (void)flags;
    if (!addr || addrlen < sizeof(struct sockaddr_in) || addr->sa_family != AF_INET)
        return EAI_FAMILY;
    const struct sockaddr_in *in = (const struct sockaddr_in *)addr;
    if (host && hostlen > 0) {
        const char *mapped = codepod_netdb_host_for_addr(in->sin_addr.s_addr);
        if (mapped) {
            snprintf(host, hostlen, "%s", mapped);
        } else if (!inet_ntop(AF_INET, &in->sin_addr, host, hostlen)) {
            return EAI_NONAME;
        }
    }
    if (serv && servlen > 0)
        snprintf(serv, servlen, "%u", (unsigned)ntohs(in->sin_port));
    return 0;
}

/* getlogin_r — POSIX: copy the login name into buf. */
int getlogin_r(char *buf, size_t bufsize) {
    static const char name[] = "user";
    if (!buf) return EINVAL;
    if (bufsize < sizeof(name)) return ERANGE;
    memcpy(buf, name, sizeof(name));
    return 0;
}
