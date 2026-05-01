REPO_ROOT := $(shell cd ../../.. && pwd)
FIXTURES := $(REPO_ROOT)/packages/orchestrator/src/platform/__tests__/fixtures
CURL_VERSION := 8.19.0
UPSTREAM := upstream
PATCHES_DIR := patches
BUILD_DIR := build
WORK_DIR := $(BUILD_DIR)/work
CANARY_DIR := canaries
GUEST_COMPAT_INCLUDE := $(abspath ../../guest-compat/include)
GUEST_COMPAT_LIB := $(REPO_ROOT)/packages/guest-compat/build/libcodepod.a

CPCC := $(REPO_ROOT)/target/release/cpcc
CPAR := $(REPO_ROOT)/target/release/cpar
CPRANLIB := $(REPO_ROOT)/target/release/cpranlib

WASI_EMULATED_CFLAGS := -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_MMAN -D_WASI_EMULATED_PROCESS_CLOCKS
WASI_EMULATED_LDFLAGS := -lwasi-emulated-mman -lwasi-emulated-process-clocks -Wl,-u,__main_argc_argv

.PHONY: all submodule-init worktree configure build canaries copy-fixtures clean ensure-toolchain ensure-compat

all: $(BUILD_DIR)/curl.wasm $(BUILD_DIR)/libcurl-fetch-canary.wasm $(BUILD_DIR)/libcurl-socket-canary.wasm

submodule-init:
	@if [ ! -f $(UPSTREAM)/configure.ac ]; then \
		echo "==> Initializing curl submodule"; \
		cd $(REPO_ROOT) && git submodule update --init packages/c-ports/curl/$(UPSTREAM); \
	fi

ensure-toolchain:
	cd $(REPO_ROOT) && cargo build --release -p cpcc-toolchain

ensure-compat:
	$(MAKE) -C $(REPO_ROOT)/packages/guest-compat lib

$(WORK_DIR)/configure.ac: submodule-init
	mkdir -p $(WORK_DIR)
	rsync -a --delete --exclude='.git' $(UPSTREAM)/ $(WORK_DIR)/
	if [ -d $(PATCHES_DIR) ] && ls $(PATCHES_DIR)/*.patch >/dev/null 2>&1; then \
		for p in $(PATCHES_DIR)/*.patch; do \
			echo "==> Applying $$p"; \
			patch -d $(WORK_DIR) -p1 < $(abspath $$p) || exit 1; \
		done; \
	fi
	touch $(WORK_DIR)/configure.ac

$(WORK_DIR)/configure: $(WORK_DIR)/configure.ac
	cd $(WORK_DIR) && autoreconf -fi

$(WORK_DIR)/Makefile: $(WORK_DIR)/configure ensure-toolchain ensure-compat
	cd $(WORK_DIR) && \
		CC="$(CPCC)" AR="$(CPAR)" RANLIB="$(CPRANLIB)" \
		CPCC_INCLUDE="$(GUEST_COMPAT_INCLUDE)" \
		CPCC_ARCHIVE="$(GUEST_COMPAT_LIB)" \
		CPCC_USE_SETJMP=1 \
		CFLAGS="$(WASI_EMULATED_CFLAGS) -O2" \
		LDFLAGS="$(WASI_EMULATED_LDFLAGS)" \
		ac_cv_func_fork=no \
		ac_cv_func_vfork=no \
		./configure \
			--host=wasm32-wasi \
			--prefix=/usr \
			--disable-shared \
			--enable-static \
			--disable-threaded-resolver \
			--disable-verbose \
			--disable-docs \
			--disable-manual \
			--disable-libcurl-option \
			--without-ssl \
			--without-zlib \
			--without-brotli \
			--without-zstd \
			--without-libpsl \
			--without-nghttp2 \
			--without-ngtcp2 \
			--without-nghttp3 \
			--disable-ftp \
			--disable-file \
			--disable-ldap \
			--disable-ldaps \
			--disable-rtsp \
			--disable-proxy \
			--disable-dict \
			--disable-telnet \
			--disable-tftp \
			--disable-pop3 \
			--disable-imap \
			--disable-smb \
			--disable-smtp \
			--disable-gopher \
			--disable-mqtt

configure: $(WORK_DIR)/Makefile

$(BUILD_DIR)/curl.wasm: $(WORK_DIR)/Makefile ensure-compat
	cd $(WORK_DIR) && \
		CPCC_ARCHIVE="$(GUEST_COMPAT_LIB)" \
		CPCC_INCLUDE="$(GUEST_COMPAT_INCLUDE)" \
		CPCC_USE_SETJMP=1 \
		$(MAKE) CC="$(CPCC)" AR="$(CPAR)" RANLIB="$(CPRANLIB)" \
			VERSION="$(CURL_VERSION)" \
			all
	cp $(WORK_DIR)/src/curl $(BUILD_DIR)/curl.wasm

$(BUILD_DIR)/libcurl-fetch-canary.wasm: $(BUILD_DIR)/curl.wasm $(CANARY_DIR)/libcurl-fetch-canary.c ensure-compat
	CPCC_ARCHIVE="$(GUEST_COMPAT_LIB)" \
	CPCC_INCLUDE="$(GUEST_COMPAT_INCLUDE)" \
	CPCC_USE_SETJMP=1 \
	$(CPCC) \
		-I$(WORK_DIR)/include \
		-I$(WORK_DIR)/lib \
		-I$(GUEST_COMPAT_INCLUDE) \
		$(WASI_EMULATED_CFLAGS) \
		-o $@ \
		$(CANARY_DIR)/libcurl-fetch-canary.c \
		$(WORK_DIR)/lib/.libs/libcurl.a \
		$(WASI_EMULATED_LDFLAGS)

$(BUILD_DIR)/libcurl-socket-canary.wasm: $(BUILD_DIR)/curl.wasm $(CANARY_DIR)/libcurl-socket-canary.c ensure-compat
	CPCC_ARCHIVE="$(GUEST_COMPAT_LIB)" \
	CPCC_INCLUDE="$(GUEST_COMPAT_INCLUDE)" \
	CPCC_USE_SETJMP=1 \
	$(CPCC) \
		-I$(WORK_DIR)/include \
		-I$(WORK_DIR)/lib \
		-I$(GUEST_COMPAT_INCLUDE) \
		$(WASI_EMULATED_CFLAGS) \
		-o $@ \
		$(CANARY_DIR)/libcurl-socket-canary.c \
		$(WORK_DIR)/lib/.libs/libcurl.a \
		$(WASI_EMULATED_LDFLAGS)

copy-fixtures: all
	cp $(BUILD_DIR)/curl.wasm $(FIXTURES)/curl.wasm
	cp $(BUILD_DIR)/libcurl-fetch-canary.wasm $(FIXTURES)/libcurl-fetch-canary.wasm
	cp $(BUILD_DIR)/libcurl-socket-canary.wasm $(FIXTURES)/libcurl-socket-canary.wasm

clean:
	rm -rf $(BUILD_DIR)
