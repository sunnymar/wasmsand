#ifndef CODEPOD_RUNTIME_H
#define CODEPOD_RUNTIME_H

#include <stddef.h>

__attribute__((import_module("codepod"), import_name("host_run_command")))
int codepod_host_run_command(int req_ptr, int req_len, int out_ptr, int out_cap);

__attribute__((import_module("codepod"), import_name("host_dup2")))
int codepod_host_dup2(int src_fd, int dst_fd);

int codepod_json_call(const char *json, char **out, size_t *out_len);

#endif
