#ifndef CODEPOD_BUSYBOX_COMPAT_PWD_H
#define CODEPOD_BUSYBOX_COMPAT_PWD_H

#include <sys/types.h>
#include <stddef.h>

struct passwd {
	char *pw_name;
	char *pw_passwd;
	uid_t pw_uid;
	gid_t pw_gid;
	char *pw_gecos;
	char *pw_dir;
	char *pw_shell;
};

void setpwent(void);
void endpwent(void);
struct passwd *getpwent(void);
struct passwd *getpwnam(const char *name);
int getpwnam_r(const char *restrict name,
	struct passwd *restrict pwd,
	char *restrict buf,
	size_t buflen,
	struct passwd **restrict result);
struct passwd *getpwuid(uid_t uid);
int getpwuid_r(uid_t uid,
	struct passwd *restrict pwd,
	char *restrict buf,
	size_t buflen,
	struct passwd **restrict result);

#endif
