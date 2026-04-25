#ifndef CODEPOD_COMPAT_UNISTD_H
#define CODEPOD_COMPAT_UNISTD_H

#include_next <unistd.h>

int dup2(int oldfd, int newfd);
int getgroups(int size, gid_t list[]);

#endif
