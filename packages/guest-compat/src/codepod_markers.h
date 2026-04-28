#ifndef CODEPOD_MARKERS_H
#define CODEPOD_MARKERS_H

#include <stdint.h>

/*
 * Implementation-signature markers for §Verifying Precedence.
 *
 * The codepod compat library can run in two verification modes:
 *
 * - **Production / default** (no `-DCODEPOD_GUEST_COMPAT_MARKERS`):
 *   The macros below compile to nothing.  No marker functions are
 *   emitted, no extra exports are forced.  cpcheck verifies link
 *   precedence *structurally*: every Tier 1 symbol must be exported
 *   from the wasm, and *none* of them may appear in the import
 *   section (which would mean a wasi syscall stub won the link).
 *   This works because cpcc `--whole-archive`-links our compat lib,
 *   so our symbol is structurally present and wins by link order.
 *
 * - **Debug / instrumented** (`-DCODEPOD_GUEST_COMPAT_MARKERS=1`):
 *   Each Tier 1 symbol's body emits a side-effecting call to a
 *   companion marker function returning a distinct magic constant.
 *   cpcheck's `--mode=markers` then verifies the body in the
 *   pre-opt wasm contains that call — proving the bytes that ran
 *   came from our compat source, not a wasi-libc stub of the same
 *   name.  Useful while iterating on the compat layer; brittle for
 *   trivial bodies (LTO loves to inline `(void)args; return 0;`).
 *
 * Constants are arbitrary distinct non-zero magic numbers; they
 * exist only to make the marker bodies individually identifiable in
 * binary dumps when markers are enabled.
 */

#ifdef CODEPOD_GUEST_COMPAT_MARKERS

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

/* The call goes through a volatile function-pointer indirection so
 * the compiler can't fold the marker function inline — even when LTO
 * sees that the marker's body is a single volatile load. */
#define CODEPOD_MARKER_CALL(sym)                                              \
  do {                                                                        \
    typedef uint32_t (*_codepod_marker_fn_##sym)(void);                       \
    volatile _codepod_marker_fn_##sym _codepod_marker_call_##sym =            \
      &__codepod_guest_compat_marker_##sym;                                   \
    volatile uint32_t _codepod_marker_sink = _codepod_marker_call_##sym();    \
    (void)_codepod_marker_sink;                                               \
  } while (0)

#else /* !CODEPOD_GUEST_COMPAT_MARKERS — production / default */

/* Production: no marker plumbing.  cpcheck switches to structural
 * verification (no Tier 1 symbol may appear in the wasm imports,
 * meaning our --whole-archive'd compat impl wins by link order). */
#define CODEPOD_DEFINE_MARKER(sym, magic) /* nothing */
#define CODEPOD_DECLARE_MARKER(sym)       /* nothing */
#define CODEPOD_MARKER_CALL(sym)          ((void)0)

#endif /* CODEPOD_GUEST_COMPAT_MARKERS */

#endif /* CODEPOD_MARKERS_H */
