/* Networking name-resolution stubs.
 *
 * wasi-libc has no <netdb.h>: gethostbyname/getaddrinfo all expect a
 * resolver, and codepod doesn't expose one to the guest (sandbox
 * networking goes through host_network_fetch, which speaks HTTP/HTTPS,
 * not DNS).
 *
 * The bodies below are the honest answer: every lookup fails with
 * HOST_NOT_FOUND.  Programs that gate behavior on this (BusyBox's
 * herror_msg, ping/wget/etc.) compile and link, and at runtime they
 * see "no DNS" and fall back / report the error cleanly. */

#include <arpa/inet.h>
#include <errno.h>
#include <netdb.h>
#include <stdio.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

int h_errno = 1;  /* HOST_NOT_FOUND */

char *hstrerror(int err) {
    /* Returned strings are static literals; the non-const return type
     * matches glibc's historical signature (POSIX is stricter, but
     * BusyBox and friends compile against the glibc one). */
    switch (err) {
        case 1: return (char *)"Host not found";
        case 2: return (char *)"Try again";
        case 3: return (char *)"Non-recoverable error";
        case 4: return (char *)"No address";
        default: return (char *)"Unknown host error";
    }
}

struct hostent *gethostbyname(const char *name) {
    (void)name;
    h_errno = 1;  /* HOST_NOT_FOUND */
    return NULL;
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

static struct sockaddr_in codepod_ai_addr;
static struct addrinfo codepod_ai;
static char codepod_ai_canonname[256];
static char codepod_last_host[256];
static uint32_t codepod_last_synthetic_addr;

const char *codepod_netdb_host_for_addr(uint32_t addr_be);
uint32_t codepod_netdb_addr_for_host(const char *host);

static uint16_t parse_service_port(const char *service) {
    unsigned long port = 0;
    if (!service || !*service) return 0;
    for (const char *p = service; *p; ++p) {
        if (*p < '0' || *p > '9') return 0;
        port = port * 10 + (unsigned long)(*p - '0');
        if (port > 65535) return 0;
    }
    return (uint16_t)port;
}

int getaddrinfo(const char *node, const char *service,
                const struct addrinfo *hints, struct addrinfo **res) {
    if (!res) return -2;  /* EAI_NONAME */
    *res = NULL;

    int family = hints ? hints->ai_family : AF_INET;
    if (family != AF_UNSPEC && family != AF_INET) {
        return -2;
    }

    const char *host = (node && *node) ? node : "0.0.0.0";
    memset(&codepod_ai_addr, 0, sizeof(codepod_ai_addr));
    codepod_ai_addr.sin_family = AF_INET;
    codepod_ai_addr.sin_port = htons(parse_service_port(service));

    if (strcmp(host, "localhost") == 0) {
        codepod_ai_addr.sin_addr.s_addr = htonl(0x7f000001u);
    } else if (inet_pton(AF_INET, host, &codepod_ai_addr.sin_addr) != 1) {
        codepod_ai_addr.sin_addr.s_addr = codepod_netdb_addr_for_host(host);
        if (codepod_ai_addr.sin_addr.s_addr == 0) return -2;
    }

    memset(&codepod_ai, 0, sizeof(codepod_ai));
    codepod_ai.ai_family = AF_INET;
    codepod_ai.ai_socktype = hints ? hints->ai_socktype : 0;
    codepod_ai.ai_protocol = hints ? hints->ai_protocol : 0;
    codepod_ai.ai_addrlen = sizeof(codepod_ai_addr);
    codepod_ai.ai_addr = (struct sockaddr *)&codepod_ai_addr;
    if (hints && (hints->ai_flags & AI_CANONNAME)) {
        snprintf(codepod_ai_canonname, sizeof(codepod_ai_canonname), "%s", host);
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
        case 0: return "Success";
        case -2: return "Name or service not known";
        default: return "Unknown getaddrinfo error";
    }
}

int getnameinfo(const struct sockaddr *addr, socklen_t addrlen,
                char *host, socklen_t hostlen,
                char *serv, socklen_t servlen, int flags) {
    (void)flags;
    if (!addr || addrlen < sizeof(struct sockaddr_in) || addr->sa_family != AF_INET) {
        return -2;
    }
    const struct sockaddr_in *in = (const struct sockaddr_in *)addr;
    if (host && hostlen > 0) {
        const char *mapped = codepod_netdb_host_for_addr(in->sin_addr.s_addr);
        if (mapped) {
            snprintf(host, hostlen, "%s", mapped);
        } else if (!inet_ntop(AF_INET, &in->sin_addr, host, hostlen)) {
            return -2;
        }
    }
    if (serv && servlen > 0) {
        snprintf(serv, servlen, "%u", (unsigned)ntohs(in->sin_port));
    }
    return 0;
}

const char *codepod_netdb_host_for_addr(uint32_t addr_be) {
    if (addr_be == htonl(0x7f000001u)) return "127.0.0.1";
    if (addr_be == codepod_last_synthetic_addr && codepod_last_host[0] != '\0') {
        return codepod_last_host;
    }
    return NULL;
}

uint32_t codepod_netdb_addr_for_host(const char *host) {
    if (!host || !*host) return 0;
    if (strcmp(host, "localhost") == 0) return htonl(0x7f000001u);

    uint32_t hash = 2166136261u;
    for (const unsigned char *p = (const unsigned char *)host; *p; ++p) {
        hash ^= (uint32_t)*p;
        hash *= 16777619u;
    }

    /* 10.255.x.y is non-routable inside Codepod; connect() maps it back
     * to the original hostname through codepod_netdb_host_for_addr(). */
    uint32_t addr = 0x0aff0000u | (hash & 0x0000ffffu);
    snprintf(codepod_last_host, sizeof(codepod_last_host), "%s", host);
    codepod_last_synthetic_addr = htonl(addr);
    return codepod_last_synthetic_addr;
}

/* getlogin_r — POSIX: copy the login name into buf.  We don't track
 * a real login session; report the canonical sandbox identity ("user",
 * matching getuid()==1000 and /etc/passwd entry).  Returns 0 on
 * success, ERANGE when buf is too small. */
int getlogin_r(char *buf, size_t bufsize) {
    static const char name[] = "user";
    if (!buf) return EINVAL;
    if (bufsize < sizeof(name)) return ERANGE;
    memcpy(buf, name, sizeof(name));
    return 0;
}
