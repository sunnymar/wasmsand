# BusyBox port built via cpcc. The compat archive is linked
# --whole-archive by cpcc, so no per-object injection is needed.

REPO_ROOT := $(shell cd ../../.. && pwd)
FIXTURES := $(REPO_ROOT)/packages/orchestrator/src/platform/__tests__/fixtures
BUSYBOX_VERSION := 1.37.0
BUSYBOX_ARCHIVE := busybox-$(BUSYBOX_VERSION).tar.bz2
BUSYBOX_URL := https://busybox.net/downloads/$(BUSYBOX_ARCHIVE)
BUILD_DIR := build
SRC_DIR := src
COMPAT_INCLUDE := $(abspath compat/include)
GUEST_COMPAT_INCLUDE := $(abspath ../../guest-compat/include)
GUEST_COMPAT_LIB := $(REPO_ROOT)/packages/guest-compat/build/libcodepod_guest_compat.a

CPCC := $(REPO_ROOT)/target/release/cpcc
CPAR := $(REPO_ROOT)/target/release/cpar
CPRANLIB := $(REPO_ROOT)/target/release/cpranlib

WASI_EMULATED_CFLAGS := -I$(COMPAT_INCLUDE) -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_MMAN -D_WASI_EMULATED_PROCESS_CLOCKS -DSOCK_RAW=3 -DSOCK_RDM=4 -DSOCK_SEQPACKET=5 -mllvm -wasm-enable-sjlj
WASI_EMULATED_LDFLAGS := -lwasi-emulated-signal -lwasi-emulated-mman -lwasi-emulated-process-clocks -Wl,-u,__main_argc_argv

.PHONY: all fetch configure copy-fixtures clean ensure-toolchain ensure-compat

all: $(BUILD_DIR)/busybox.wasm

# Always delegate to cargo / upstream make so edits propagate. Cargo's
# and make's own up-to-date checks are the right source of truth;
# existence-only `test -x` / `test -f` guards would mask stale artifacts
# after source edits under toolchain/cpcc/ or guest-compat/src/.
ensure-toolchain:
	cd $(REPO_ROOT) && cargo build --release -p cpcc-toolchain

ensure-compat:
	$(MAKE) -C $(REPO_ROOT)/packages/guest-compat lib

fetch:
	mkdir -p $(BUILD_DIR) $(SRC_DIR)
	if [ ! -f $(SRC_DIR)/Makefile ]; then \
		curl -L $(BUSYBOX_URL) | tar -xj -C src --strip-components=1; \
	fi

configure: fetch busybox.config compat/include/paths.h ensure-toolchain
	cd $(SRC_DIR) && \
		$(MAKE) CC="$(CPCC)" AR="$(CPAR)" RANLIB="$(CPRANLIB)" \
			KCONFIG_ALLCONFIG="$(abspath busybox.config)" allnoconfig && \
		awk '\
			function key(line) { \
				if (line ~ /^CONFIG_[A-Za-z0-9_]+=/) { \
					split(line, parts, "="); \
					return parts[1]; \
				} \
				if (line ~ /^# CONFIG_[A-Za-z0-9_]+ is not set$$/) { \
					sub(/^# /, "", line); \
					sub(/ is not set$$/, "", line); \
					return line; \
				} \
				return ""; \
			} \
			FNR == NR { \
				current_key = key($$0); \
				if (current_key != "") seen[current_key] = 1; \
				overrides[++count] = $$0; \
				next; \
			} \
			{ \
				current_key = key($$0); \
				if (current_key != "" && seen[current_key]) next; \
				print; \
			} \
			END { \
				print ""; \
				for (i = 1; i <= count; i++) print overrides[i]; \
			} \
		' "$(abspath busybox.config)" .config > .config.merged && \
		mv .config.merged .config && \
		rm -rf include/config include/autoconf.h && \
		sleep 1 && \
		$(MAKE) CC="$(CPCC)" AR="$(CPAR)" RANLIB="$(CPRANLIB)" silentoldconfig && \
		sed -i.bak \
			-e 's|^START_GROUP=.*|START_GROUP=""|' \
			-e 's|^END_GROUP=.*|END_GROUP=""|' \
			-e 's|-Wl,--warn-common||g' \
			-e 's|-Wl,--sort-common||g' \
			-e 's|-Wl,--sort-section,alignment||g' \
			scripts/trylink

$(BUILD_DIR)/busybox.wasm: configure ensure-compat
	cd $(SRC_DIR) && \
		CPCC_ARCHIVE="$(GUEST_COMPAT_LIB)" \
		CPCC_INCLUDE="$(GUEST_COMPAT_INCLUDE)" \
		$(MAKE) CC="$(CPCC)" AR="$(CPAR)" RANLIB="$(CPRANLIB)" \
			EXTRA_CFLAGS="$(WASI_EMULATED_CFLAGS)" \
			EXTRA_LDFLAGS="$(WASI_EMULATED_LDFLAGS)" \
			SKIP_STRIP=y \
			busybox
	cp $(SRC_DIR)/busybox_unstripped $(BUILD_DIR)/busybox.wasm

copy-fixtures: $(BUILD_DIR)/busybox.wasm
	cp $(BUILD_DIR)/busybox.wasm $(FIXTURES)/busybox.wasm

clean:
	rm -rf $(BUILD_DIR) $(SRC_DIR)
