# Build the BusyBox phase-1 pilot as a recipe on top of the shared host-side
# C builder. The recipe intentionally stays narrow: fetch upstream BusyBox,
# apply the pinned config, inject the minimum known include shim, and surface
# any remaining build blockers honestly.

REPO_ROOT := $(shell cd ../../.. && pwd)
FIXTURES := $(REPO_ROOT)/packages/orchestrator/src/platform/__tests__/fixtures
BUILD := $(REPO_ROOT)/scripts/build-c-port.sh
BUSYBOX_VERSION := 1.37.0
BUSYBOX_ARCHIVE := busybox-$(BUSYBOX_VERSION).tar.bz2
BUSYBOX_URL := https://busybox.net/downloads/$(BUSYBOX_ARCHIVE)
BUILD_DIR := build
SRC_DIR := src
COMPAT_INCLUDE := $(abspath compat/include)
CODEPOD_COMPAT_INCLUDE := $(abspath ../../guest-compat/include)
CODEPOD_SCHED_SRC := $(REPO_ROOT)/packages/guest-compat/src/codepod_sched.c
CODEPOD_SCHED_HDR := $(REPO_ROOT)/packages/guest-compat/include/sched.h
CODEPOD_SIGNAL_SRC := $(REPO_ROOT)/packages/guest-compat/src/codepod_signal.c
CODEPOD_SIGNAL_HDR := $(REPO_ROOT)/packages/guest-compat/include/signal.h
CODEPOD_UNISTD_SRC := $(REPO_ROOT)/packages/guest-compat/src/codepod_unistd.c
CODEPOD_UNISTD_HDR := $(REPO_ROOT)/packages/guest-compat/include/unistd.h
TOOLCHAIN_ENV := eval "$$($(BUILD) env)"
AR_WRAPPER := $(abspath $(BUILD_DIR)/busybox-ar-wrapper.sh)
CODEPOD_SCHED_OBJ := $(abspath $(BUILD_DIR)/codepod_sched.o)
CODEPOD_SIGNAL_OBJ := $(abspath $(BUILD_DIR)/codepod_signal.o)
CODEPOD_UNISTD_OBJ := $(abspath $(BUILD_DIR)/codepod_unistd.o)
WASI_EMULATED_CFLAGS := -I$(COMPAT_INCLUDE) -I$(CODEPOD_COMPAT_INCLUDE) -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_MMAN -D_WASI_EMULATED_PROCESS_CLOCKS -DSOCK_RAW=3 -DSOCK_RDM=4 -DSOCK_SEQPACKET=5 -mllvm -wasm-enable-sjlj
WASI_EMULATED_LDFLAGS := -lwasi-emulated-signal -lwasi-emulated-mman -lwasi-emulated-process-clocks

.PHONY: all fetch configure copy-fixtures clean

all: $(BUILD_DIR)/busybox.wasm

fetch:
	mkdir -p $(BUILD_DIR) $(SRC_DIR)
	if [ ! -f $(SRC_DIR)/Makefile ]; then \
		curl -L $(BUSYBOX_URL) | tar -xj -C src --strip-components=1; \
	fi

configure: fetch busybox.config compat/include/paths.h $(BUILD)
	cd $(SRC_DIR) && $(TOOLCHAIN_ENV) && \
		$(MAKE) CC="$$CC" AR="$$AR" RANLIB="$$RANLIB" \
		KCONFIG_ALLCONFIG="$(abspath busybox.config)" \
		allnoconfig && \
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
		$(MAKE) CC="$$CC" AR="$$AR" RANLIB="$$RANLIB" silentoldconfig

$(CODEPOD_SCHED_OBJ): $(CODEPOD_SCHED_SRC) $(CODEPOD_SCHED_HDR) $(BUILD) | $(BUILD_DIR)
	$(BUILD) --include $(CODEPOD_COMPAT_INCLUDE) --compile-only --source $(CODEPOD_SCHED_SRC) --output $@

$(CODEPOD_SIGNAL_OBJ): $(CODEPOD_SIGNAL_SRC) $(CODEPOD_SIGNAL_HDR) $(BUILD) | $(BUILD_DIR)
	$(BUILD) --include $(CODEPOD_COMPAT_INCLUDE) --compile-only --source $(CODEPOD_SIGNAL_SRC) --output $@

$(CODEPOD_UNISTD_OBJ): $(CODEPOD_UNISTD_SRC) $(CODEPOD_UNISTD_HDR) $(BUILD) | $(BUILD_DIR)
	$(BUILD) --include $(CODEPOD_COMPAT_INCLUDE) --compile-only --source $(CODEPOD_UNISTD_SRC) --output $@

$(BUILD_DIR)/busybox.wasm: configure $(CODEPOD_SCHED_OBJ) $(CODEPOD_SIGNAL_OBJ) $(CODEPOD_UNISTD_OBJ)
	cd $(SRC_DIR) && $(TOOLCHAIN_ENV) && \
		printf '%s\n' \
			'#!/bin/sh' \
			'set -eu' \
			"real_ar='$$AR'" \
			'if [ "$$#" -ge 2 ]; then' \
			'	op="$$1"' \
			'	archive="$$2"' \
			'	shift 2' \
			'	case "$$op" in' \
			'		*q*|*r*)' \
			'			if [ "$$#" -eq 0 ]; then' \
			'				printf '\''!<arch>\n'\'' >"$$archive"' \
			'				exit 0' \
			'			fi' \
			'			;;' \
			'	esac' \
			'	exec "$$real_ar" "$$op" "$$archive" "$$@"' \
			'fi' \
			'exec "$$real_ar" "$$@"' \
			> "$(AR_WRAPPER)" && \
		chmod +x "$(AR_WRAPPER)" && \
		$(MAKE) CC="$$CC" AR="$(AR_WRAPPER)" RANLIB="$$RANLIB" \
			EXTRA_CFLAGS="$(WASI_EMULATED_CFLAGS)" \
			EXTRA_LDFLAGS="$(WASI_EMULATED_LDFLAGS)" \
			LDLIBS="$(CODEPOD_SCHED_OBJ) $(CODEPOD_SIGNAL_OBJ) $(CODEPOD_UNISTD_OBJ)" \
			busybox
	cp $(SRC_DIR)/busybox_unstripped $(BUILD_DIR)/busybox.wasm

copy-fixtures: $(BUILD_DIR)/busybox.wasm
	cp $(BUILD_DIR)/busybox.wasm $(FIXTURES)/busybox.wasm

clean:
	rm -rf $(BUILD_DIR) $(SRC_DIR)
