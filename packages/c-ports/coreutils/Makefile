# GNU coreutils port — six tools (csplit, fmt, join, numfmt,
# sha224sum, sha384sum) built via cpcc.  One submodule, one
# bootstrap, one configure, six wasm artifacts.
#
# coreutils' build expects gnulib to be present alongside the source
# tree as a sibling git submodule — `./bootstrap` populates `lib/`
# with symlinks into `gnulib/lib/`.  We do the same: rsync upstream
# (including gnulib) into build/work/, then run bootstrap +
# configure inside the work tree.

REPO_ROOT := $(shell cd ../../.. && pwd)
FIXTURES := $(REPO_ROOT)/packages/orchestrator/src/platform/__tests__/fixtures
COREUTILS_VERSION := 9.11
UPSTREAM := upstream
PATCHES_DIR := patches
BUILD_DIR := build
WORK_DIR := $(BUILD_DIR)/work
GUEST_COMPAT_INCLUDE := $(abspath ../../guest-compat/include)
GUEST_COMPAT_LIB := $(REPO_ROOT)/packages/guest-compat/build/libcodepod_guest_compat.a

CPCC := $(REPO_ROOT)/target/release/cpcc
CPAR := $(REPO_ROOT)/target/release/cpar
CPRANLIB := $(REPO_ROOT)/target/release/cpranlib

TOOLS := csplit fmt join numfmt sha224sum sha384sum
TOOL_BINS := $(addprefix $(BUILD_DIR)/,$(addsuffix .wasm,$(TOOLS)))

WASI_EMULATED_CFLAGS := -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_MMAN -D_WASI_EMULATED_PROCESS_CLOCKS
# We don't link -lwasi-emulated-signal: codepod ships full signal/
# sigaction/raise/sigemptyset/etc. impls in libcodepod_guest_compat
# (codepod_signal.c) that route through handler tables we own — more
# useful than wasi-emulated's no-op stubs, but the symbol set
# overlaps and would duplicate at link time.  -lwasi-emulated-process-
# clocks supplies getrusage (zero-fills the rusage struct) which we
# want for tools that probe it.
WASI_EMULATED_LDFLAGS := -lwasi-emulated-mman -lwasi-emulated-process-clocks -Wl,-u,__main_argc_argv

# Cross-compile cache vars for runtime feature probes that gnulib /
# coreutils run.  Without these, configure either picks the host's
# answer (wrong) or aborts asking the user to set them.
CONFIG_CACHE_VARS := \
	gl_cv_func_mmap_anon=no \
	gl_cv_func_mmap_dev_zero=no \
	gl_cv_func_mmap_file=no \
	ac_cv_func_mmap_fixed_mapped=no \
	ac_cv_func_fork=no \
	ac_cv_func_vfork=no \
	gl_cv_func_setlocale_null_all_mtsafe=yes \
	gl_cv_func_setlocale_null_mtsafe=yes \
	gl_cv_pthread_rwlock_rdlock_prefer_writer=yes

.PHONY: all submodule-init worktree bootstrap configure build copy-fixtures clean ensure-toolchain ensure-compat

all: $(TOOL_BINS)

submodule-init:
	@if [ ! -f $(UPSTREAM)/configure.ac ]; then \
		echo "==> Initializing coreutils submodule"; \
		cd $(REPO_ROOT) && git submodule update --init packages/c-ports/coreutils/$(UPSTREAM); \
	fi
	@if [ ! -f $(UPSTREAM)/gnulib/Makefile ] && [ ! -d $(UPSTREAM)/gnulib/lib ]; then \
		echo "==> Initializing nested gnulib submodule"; \
		cd $(UPSTREAM) && git submodule update --init gnulib; \
	fi

ensure-toolchain:
	cd $(REPO_ROOT) && cargo build --release -p cpcc-toolchain

ensure-compat:
	$(MAKE) -C $(REPO_ROOT)/packages/guest-compat lib

# ── Worktree setup ──
# `rsync -a` preserves upstream timestamps, but we use the stamp on
# configure.ac as the trigger for re-bootstrapping after a wipe.
# Touch it forward so make knows the rsync invalidated downstream
# build state (configure, lib/ symlinks into gnulib, etc.).
$(WORK_DIR)/configure.ac: submodule-init
	mkdir -p $(WORK_DIR)
	rsync -a --delete --exclude='.git' $(UPSTREAM)/ $(WORK_DIR)/
	if [ -d $(PATCHES_DIR) ] && ls $(PATCHES_DIR)/*.patch >/dev/null 2>&1; then \
		for p in $(PATCHES_DIR)/*.patch; do \
			echo "==> Applying $$p"; \
			git -C $(WORK_DIR) apply --whitespace=nowarn $(abspath $$p); \
		done; \
	fi
	touch $(WORK_DIR)/configure.ac

# ── Bootstrap ──
# coreutils' bootstrap script does autopoint + autoreconf + creates
# lib/ symlinks into gnulib/.  Needs network access only if the gnulib
# submodule isn't checked out (it is, by submodule-init above).
$(WORK_DIR)/configure: $(WORK_DIR)/configure.ac
	cd $(WORK_DIR) && ./bootstrap --no-git --skip-po --gnulib-srcdir=gnulib

bootstrap: $(WORK_DIR)/configure

# ── Configure for wasm ──
# CPCC_INCLUDE / CPCC_ARCHIVE must be set during configure too —
# autoconf's HAVE_<header>.h probes use cpcc as the compiler, and
# without the compat include path they wrongly conclude that
# netdb.h, sys/wait.h, etc. are missing.  We also force-enable our
# compat library at configure time so link probes for symbols like
# gethostbyname / chown / waitpid succeed.
# AC_INIT bakes VERSION="UNKNOWN" because coreutils detects its
# version from `git describe`, and our rsync strips .git.  Patch
# config.h post-configure so tools report the real upstream tag.
$(WORK_DIR)/Makefile: $(WORK_DIR)/configure ensure-toolchain ensure-compat
	@$(MAKE) -s _configure_step
	sed -i.bak \
		-e 's|^#define PACKAGE_VERSION .*|#define PACKAGE_VERSION "$(COREUTILS_VERSION)"|' \
		-e 's|^#define VERSION .*|#define VERSION "$(COREUTILS_VERSION)"|' \
		-e 's|^#define PACKAGE_STRING .*|#define PACKAGE_STRING "GNU coreutils $(COREUTILS_VERSION)"|' \
		$(WORK_DIR)/lib/config.h

# Internal helper: do the actual configure run.  Split out so the
# parent rule can run the version-patch sed afterwards.
.PHONY: _configure_step
_configure_step:
	cd $(WORK_DIR) && \
		CC="$(CPCC)" AR="$(CPAR)" RANLIB="$(CPRANLIB)" \
		CPCC_INCLUDE="$(GUEST_COMPAT_INCLUDE)" \
		CPCC_ARCHIVE="$(GUEST_COMPAT_LIB)" \
		CFLAGS="$(WASI_EMULATED_CFLAGS) -O2" \
		LDFLAGS="$(WASI_EMULATED_LDFLAGS)" \
		$(CONFIG_CACHE_VARS) \
		./configure \
			--host=wasm32-wasi \
			--build=$$(./build-aux/config.guess) \
			--prefix=/usr \
			--disable-shared --enable-static \
			--disable-nls \
			--disable-acl \
			--disable-libsmack \
			--disable-libcap \
			--without-libgmp \
			--without-selinux \
			--without-openssl

configure: $(WORK_DIR)/Makefile

# ── Build the six tools ──
# coreutils' Makefile resolves each tool's CPPFLAGS automatically
# (sha224sum and sha384sum get -DHASH_ALGO_SHA224=1 / -DHASH_ALGO_SHA384=1
# from src/local.mk).  We don't have to special-case them.
#
# `make src/<name>` skips the generated headers in lib/ (configmake.h,
# version.h, etc.) — those only come along with `make all-am` or via
# the lib/libcoreutils.a target.  We build lib/ first so every tool
# build sees the generated includes.
$(WORK_DIR)/lib/libcoreutils.a: $(WORK_DIR)/Makefile ensure-compat
	# Generate BUILT_SOURCES (lib/configmake.h, lib/string.h with the
	# streq macro, lib/parse-datetime.c via bison, src/version.h, etc.)
	# explicitly first.  automake wires these into the `all` target,
	# but `all` also tries to build every coreutils tool — many of
	# which we don't target and which may surface gaps that block
	# `lib/libcoreutils.a` from ever being produced.  Running `make
	# all -k` builds whatever it can; libcoreutils.a comes along the
	# way.  Tools we DO target are built individually by the per-tool
	# rule below, against this libcoreutils.a.
	#
	# PARSE_DATETIME_BISON is set to ':' (no-op) by configure during
	# cross-compile because there's no `wasm32-wasi-bison`.  We have
	# host bison; override so parse-datetime.c gets generated.
	# coreutils' .y uses bison 3+ syntax (`%define api.pure`); macOS
	# ships bison 2.3 system-wide for licensing reasons, so we prefer
	# brew's bison 3.x if installed.
	BISON=$$(command -v $$(brew --prefix bison 2>/dev/null)/bin/bison 2>/dev/null || command -v bison) ; \
	cd $(WORK_DIR) && \
		CPCC_ARCHIVE="$(GUEST_COMPAT_LIB)" \
		CPCC_INCLUDE="$(GUEST_COMPAT_INCLUDE)" \
		$(MAKE) CC="$(CPCC)" AR="$(CPAR)" RANLIB="$(CPRANLIB)" \
			PARSE_DATETIME_BISON="$$BISON" \
			MAKEINFO=true \
			VERSION="$(COREUTILS_VERSION)" \
			PACKAGE_VERSION="$(COREUTILS_VERSION)" \
			-k all 2>&1 | tail -20 || true
	test -f $(WORK_DIR)/lib/libcoreutils.a

$(BUILD_DIR)/%.wasm: $(WORK_DIR)/lib/libcoreutils.a
	cd $(WORK_DIR) && \
		CPCC_ARCHIVE="$(GUEST_COMPAT_LIB)" \
		CPCC_INCLUDE="$(GUEST_COMPAT_INCLUDE)" \
		$(MAKE) CC="$(CPCC)" AR="$(CPAR)" RANLIB="$(CPRANLIB)" \
			MAKEINFO=true \
			VERSION="$(COREUTILS_VERSION)" \
			PACKAGE_VERSION="$(COREUTILS_VERSION)" \
			src/$*
	cp $(WORK_DIR)/src/$* $(BUILD_DIR)/$*.wasm

copy-fixtures: $(TOOL_BINS)
	for t in $(TOOLS); do cp $(BUILD_DIR)/$$t.wasm $(FIXTURES)/$$t.wasm; done

clean:
	rm -rf $(BUILD_DIR)
