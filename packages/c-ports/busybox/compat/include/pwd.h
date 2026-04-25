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

/* Stubs — no /etc/passwd in the sandbox; always return root entry or NULL */
static inline void setpwent(void) {}
static inline void endpwent(void) {}
static inline struct passwd *getpwent(void) { return (struct passwd *)0; }
static inline struct passwd *getpwnam(const char *name) {
    (void)name; return (struct passwd *)0; }
static inline int getpwnam_r(const char *restrict name,
	struct passwd *restrict pwd,
	char *restrict buf,
	size_t buflen,
	struct passwd **restrict result) {
    (void)name; (void)pwd; (void)buf; (void)buflen;
    *result = (struct passwd *)0; return 0; }
static inline struct passwd *getpwuid(uid_t uid) {
    (void)uid; return (struct passwd *)0; }
static inline int getpwuid_r(uid_t uid,
	struct passwd *restrict pwd,
	char *restrict buf,
	size_t buflen,
	struct passwd **restrict result) {
    (void)uid; (void)pwd; (void)buf; (void)buflen;
    *result = (struct passwd *)0; return 0; }

#endif
