#ifndef CODEPOD_BUSYBOX_COMPAT_GRP_H
#define CODEPOD_BUSYBOX_COMPAT_GRP_H

#include <sys/types.h>

struct group {
	char *gr_name;
	char *gr_passwd;
	gid_t gr_gid;
	char **gr_mem;
};

/* Stubs — no /etc/group in the sandbox; always return NULL */
static inline void setgrent(void) {}
static inline void endgrent(void) {}
static inline struct group *getgrent(void) { return (struct group *)0; }
static inline struct group *getgrnam(const char *name) {
    (void)name; return (struct group *)0; }
static inline struct group *getgrgid(gid_t gid) {
    (void)gid; return (struct group *)0; }
static inline int getgrouplist(const char *user, gid_t group,
    gid_t *groups, int *ngroups) {
    (void)user; (void)group; (void)groups;
    if (*ngroups >= 1) { groups[0] = 0; *ngroups = 1; return 1; }
    *ngroups = 1; return -1; }
static inline int initgroups(const char *user, gid_t group) {
    (void)user; (void)group; return 0; }

#endif
