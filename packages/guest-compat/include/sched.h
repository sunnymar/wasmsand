#ifndef CODEPOD_COMPAT_SCHED_H
#define CODEPOD_COMPAT_SCHED_H

#include <stddef.h>
#include <sys/types.h>

#define CPU_SETSIZE (8 * sizeof(unsigned long))

typedef struct {
  unsigned long __bits[1];
} cpu_set_t;

#define CPU_ZERO(set) ((set)->__bits[0] = 0ul)
#define CPU_SET(cpu, set) ((void)((cpu) < CPU_SETSIZE ? ((set)->__bits[0] |= (1ul << (cpu))) : 0))
#define CPU_CLR(cpu, set) ((void)((cpu) < CPU_SETSIZE ? ((set)->__bits[0] &= ~(1ul << (cpu))) : 0))
#define CPU_ISSET(cpu, set) ((cpu) < CPU_SETSIZE ? (((set)->__bits[0] & (1ul << (cpu))) != 0) : 0)
#define CPU_COUNT(set) ((int)CPU_ISSET(0, (set)))

int sched_getaffinity(pid_t pid, size_t cpusetsize, cpu_set_t *mask);
int sched_setaffinity(pid_t pid, size_t cpusetsize, const cpu_set_t *mask);
int sched_getcpu(void);

#endif
