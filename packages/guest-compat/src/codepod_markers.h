#ifndef CODEPOD_MARKERS_H
#define CODEPOD_MARKERS_H

#include <stdint.h>

/*
 * Implementation-signature markers for §Verifying Precedence.
 *
 * Every Tier 1 symbol has a companion exported marker function returning a
 * distinct constant. The Tier 1 function body emits a side-effecting call to
 * its marker so that link-time DCE retains both and wasm-tools can see the
 * call in the pre-opt `.wasm`. `wasm-opt` later may inline or DCE this call;
 * the signature check runs pre-opt.
 *
 * Constants are arbitrary distinct non-zero magic numbers; they exist only
 * to make the marker bodies individually identifiable in dumps.
 */

#define CODEPOD_MARKER_ATTR __attribute__((visibility("default"), used, noinline))

#define CODEPOD_DEFINE_MARKER(sym, magic)                                   \
  CODEPOD_MARKER_ATTR uint32_t __codepod_guest_compat_marker_##sym(void) {  \
    return (uint32_t)(magic);                                               \
  }

#define CODEPOD_DECLARE_MARKER(sym) \
  uint32_t __codepod_guest_compat_marker_##sym(void)

#define CODEPOD_MARKER_CALL(sym)                              \
  do {                                                        \
    volatile uint32_t _codepod_marker_sink =                  \
      __codepod_guest_compat_marker_##sym();                  \
    (void)_codepod_marker_sink;                               \
  } while (0)

#endif
