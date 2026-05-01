REPO_ROOT := $(shell cd ../../.. && pwd)
FIXTURES := $(REPO_ROOT)/packages/orchestrator/src/platform/__tests__/fixtures
UPSTREAM := upstream
BUILD_DIR := build
WORK_DIR := $(BUILD_DIR)/work
PREFIX := $(BUILD_DIR)/prefix
CANARY_DIR := canaries

CPCC := $(REPO_ROOT)/target/release/cpcc
CPAR := $(REPO_ROOT)/target/release/cpar
CPRANLIB := $(REPO_ROOT)/target/release/cpranlib
WASI_EMULATED_CFLAGS := -D_WASI_EMULATED_SIGNAL
WASI_EMULATED_LDFLAGS := -lwasi-emulated-signal

.PHONY: all submodule-init worktree lib canaries copy-fixtures clean ensure-toolchain

all: lib canaries

submodule-init:
	@if [ ! -f $(UPSTREAM)/include/mbedtls/version.h ]; then \
		echo "==> Initializing mbedTLS submodule"; \
		cd $(REPO_ROOT) && git submodule update --init packages/c-ports/mbedtls/$(UPSTREAM); \
	fi

ensure-toolchain:
	cd $(REPO_ROOT) && cargo build --release -p cpcc-toolchain

$(WORK_DIR)/include/mbedtls/version.h: submodule-init
	mkdir -p $(WORK_DIR)
	rsync -a --delete --exclude='.git' $(UPSTREAM)/ $(WORK_DIR)/
	if [ -d patches ] && ls patches/*.patch >/dev/null 2>&1; then \
		for p in patches/*.patch; do \
			echo "==> Applying $$p"; \
			patch -d $(WORK_DIR) -p1 < $(abspath $$p) || exit 1; \
		done; \
	fi
	touch $@

lib: $(WORK_DIR)/include/mbedtls/version.h ensure-toolchain
	cd $(WORK_DIR) && \
		$(MAKE) lib \
			CC="$(CPCC)" \
			AR="$(CPAR)" \
			RANLIB="$(CPRANLIB)" \
			CFLAGS="-O2 -DMBEDTLS_PLATFORM_MEMORY -D_POSIX_VERSION=200809L $(WASI_EMULATED_CFLAGS)" \
			LDFLAGS=""
	mkdir -p $(PREFIX)/include $(PREFIX)/lib
	rsync -a $(WORK_DIR)/include/ $(PREFIX)/include/
	cp $(WORK_DIR)/library/libmbedtls.a $(PREFIX)/lib/
	cp $(WORK_DIR)/library/libmbedx509.a $(PREFIX)/lib/
	cp $(WORK_DIR)/library/libmbedcrypto.a $(PREFIX)/lib/

$(BUILD_DIR)/mbedtls-version-canary.wasm: lib $(CANARY_DIR)/mbedtls-version-canary.c
	$(CPCC) \
		-I$(PREFIX)/include \
		$(WASI_EMULATED_CFLAGS) \
		-o $@ \
		$(CANARY_DIR)/mbedtls-version-canary.c \
		$(PREFIX)/lib/libmbedtls.a \
		$(PREFIX)/lib/libmbedx509.a \
		$(PREFIX)/lib/libmbedcrypto.a \
		$(WASI_EMULATED_LDFLAGS)

canaries: $(BUILD_DIR)/mbedtls-version-canary.wasm

copy-fixtures: canaries
	cp $(BUILD_DIR)/mbedtls-version-canary.wasm $(FIXTURES)/mbedtls-version-canary.wasm

clean:
	rm -rf $(BUILD_DIR)
