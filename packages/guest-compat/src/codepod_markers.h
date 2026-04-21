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

/* A volatile static prevents the compiler from constant-folding the
 * marker's return value into its callers at -O2, so that callers contain a
 * real `call` instruction (not an inlined constant) in the pre-opt .wasm —
 * which is what §Verifying Precedence stage 3 inspects.
 * export_name forces wasm-ld to emit the function as a wasm export, which
 * stage 2 of the check requires. */
#define CODEPOD_MARKER_ATTR(sym)                                            \
  __attribute__((visibility("default"), used, noinline,                     \
                 export_name("__codepod_guest_compat_marker_" #sym)))

#define CODEPOD_DEFINE_MARKER(sym, magic)                                   \
  static volatile uint32_t __codepod_marker_val_##sym = (uint32_t)(magic); \
  CODEPOD_MARKER_ATTR(sym) uint32_t __codepod_guest_compat_marker_##sym(void) { \
    return __codepod_marker_val_##sym;                                      \
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
