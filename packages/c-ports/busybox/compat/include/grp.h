#ifndef CODEPOD_BUSYBOX_COMPAT_GRP_H
#define CODEPOD_BUSYBOX_COMPAT_GRP_H

#include <sys/types.h>

struct group {
	char *gr_name;
	char *gr_passwd;
	gid_t gr_gid;
	char **gr_mem;
};

void setgrent(void);
void endgrent(void);
struct group *getgrent(void);
struct group *getgrnam(const char *name);
struct group *getgrgid(gid_t gid);
int getgrouplist(const char *user, gid_t group, gid_t *groups, int *ngroups);
int initgroups(const char *user, gid_t group);

#endif
