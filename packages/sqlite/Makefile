# Build SQLite to wasm32-wasi using wasi-sdk
#
# Prerequisites: wasi-sdk installed. Set WASI_SDK_PATH to the installation root.
# Download from https://github.com/WebAssembly/wasi-sdk/releases
#
# Examples:
#   WASI_SDK_PATH=~/.local/share/wasi-sdk-30.0-arm64-macos make
#   make copy-fixtures

SQLITE_VERSION := 3490100
SQLITE_YEAR := 2025
SQLITE_URL := https://www.sqlite.org/$(SQLITE_YEAR)/sqlite-amalgamation-$(SQLITE_VERSION).zip

WASI_SDK_PATH ?= $(HOME)/.local/share/wasi-sdk-30.0-arm64-macos
CC := $(WASI_SDK_PATH)/bin/clang
SYSROOT := $(WASI_SDK_PATH)/share/wasi-sysroot

REPO_ROOT := $(shell cd ../.. && pwd)
FIXTURES := $(REPO_ROOT)/packages/orchestrator/src/platform/__tests__/fixtures

CFLAGS := \
	--sysroot=$(SYSROOT) \
	--target=wasm32-wasi \
	-O2 \
	-DSQLITE_THREADSAFE=0 \
	-DSQLITE_OMIT_WAL \
	-DSQLITE_OMIT_LOAD_EXTENSION \
	-DSQLITE_OMIT_DEPRECATED \
	-DSQLITE_DEFAULT_LOCKING_MODE=1 \
	-DSQLITE_DQS=0 \
	-D_WASI_EMULATED_SIGNAL \
	-D_WASI_EMULATED_PROCESS_CLOCKS \
	-D_WASI_EMULATED_GETPID \
	-DSQLITE_NOHAVE_SYSTEM

LDFLAGS := \
	-lwasi-emulated-signal \
	-lwasi-emulated-process-clocks \
	-lwasi-emulated-getpid

.PHONY: all clean copy-fixtures

all: sqlite3.wasm

src/sqlite3.c:
	mkdir -p src
	curl -sL $(SQLITE_URL) -o src/sqlite.zip
	cd src && unzip -o sqlite.zip
	mv src/sqlite-amalgamation-$(SQLITE_VERSION)/* src/
	rmdir src/sqlite-amalgamation-$(SQLITE_VERSION)
	rm src/sqlite.zip

sqlite3.wasm: src/sqlite3.c
	$(CC) $(CFLAGS) $(LDFLAGS) -o $@ src/shell.c src/sqlite3.c

copy-fixtures: sqlite3.wasm
	cp sqlite3.wasm $(FIXTURES)/sqlite3.wasm

clean:
	rm -rf src sqlite3.wasm
