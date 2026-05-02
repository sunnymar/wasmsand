# CPython port built via cpcc.  Upstream python/cpython lives at
# upstream/ as a git submodule pinned to v3.14.4.  Build output stays
# under build/ so the submodule remains pristine.

REPO_ROOT := $(shell cd ../../.. && pwd)
FIXTURES := $(REPO_ROOT)/packages/orchestrator/src/platform/__tests__/fixtures
UPSTREAM := upstream
BUILD_DIR := build
WORK_DIR := $(BUILD_DIR)/work
INSTALL_DIR := $(BUILD_DIR)/install
UPSTREAM_WASI := $(UPSTREAM)/cross-build/wasm32-wasip1/python.wasm
UPSTREAM_ARTIFACT := $(BUILD_DIR)/cpython3-upstream.wasm
CODEPOD_ARTIFACT := $(BUILD_DIR)/cpython3.wasm

CPCC := $(REPO_ROOT)/target/release/cpcc
CPAR := $(REPO_ROOT)/target/release/cpar
CPRANLIB := $(REPO_ROOT)/target/release/cpranlib
DENO := $(shell command -v deno 2>/dev/null || command -v $(HOME)/.deno/bin/deno)
CODEPOD_HOST_RUNNER := $(DENO) run -A --no-check $(REPO_ROOT)/scripts/run-wasm-test-in-sandbox.ts
CODEPOD_ARCHIVE := $(REPO_ROOT)/packages/guest-compat/build/libcodepod.a
CODEPOD_INCLUDE := $(REPO_ROOT)/packages/guest-compat/include
WASI_SDK_PATH ?= $(shell $(CPCC) --print-sdk-path)

.PHONY: all submodule-init print-build-env upstream-wasi-build worktree codepod-wasi-build run-print run-codepod-version copy-fixtures clean

all: $(CODEPOD_ARTIFACT)

submodule-init:
	@if [ ! -f $(UPSTREAM)/Tools/wasm/wasi.py ]; then \
		echo "==> Initializing CPython submodule"; \
		cd $(REPO_ROOT) && git submodule update --init packages/c-ports/cpython/$(UPSTREAM); \
	fi

print-build-env: submodule-init
	@echo "CPCC=$(CPCC)"
	@echo "CPAR=$(CPAR)"
	@echo "CPRANLIB=$(CPRANLIB)"
	@echo "DENO=$(DENO)"
	@echo "CODEPOD_HOST_RUNNER=$(CODEPOD_HOST_RUNNER)"
	@echo "CODEPOD_ARCHIVE=$(CODEPOD_ARCHIVE)"
	@echo "CODEPOD_INCLUDE=$(CODEPOD_INCLUDE)"
	@echo "WASI_SDK_PATH=$(WASI_SDK_PATH)"
	@echo "INSTALL_DIR=$(INSTALL_DIR)"

upstream-wasi-build: $(UPSTREAM_WASI)

$(UPSTREAM_WASI): | submodule-init
	cd $(UPSTREAM) && WASI_SDK_PATH="$(WASI_SDK_PATH)" python3 Tools/wasm/wasi.py build -- --config-cache

worktree: $(WORK_DIR)/.staged

$(WORK_DIR)/.staged: | submodule-init
	mkdir -p $(BUILD_DIR)
	rsync -a --delete \
		--delete-excluded \
		--exclude='.git' \
		--exclude='cross-build' \
		--exclude='Modules/Setup.local' \
		$(UPSTREAM)/ $(WORK_DIR)/
	@if [ -d patches/3.14 ]; then \
		for p in patches/3.14/*.patch; do \
			[ -e "$$p" ] || continue; \
			echo "==> Applying $$p"; \
			git -C $(WORK_DIR) apply --whitespace=nowarn "$$(realpath "$$p")"; \
		done; \
	fi
	touch $@

codepod-wasi-build: $(CODEPOD_ARTIFACT)

$(CODEPOD_ARTIFACT): $(WORK_DIR)/.staged
	@test -f $(CODEPOD_ARCHIVE) || (echo "missing $(CODEPOD_ARCHIVE); run make -C packages/guest-compat lib" >&2; exit 2)
	cd $(WORK_DIR) && WASI_SDK_PATH="$(WASI_SDK_PATH)" python3 Tools/wasm/wasi.py build-python
	cd $(WORK_DIR) && CPCC_ARCHIVE="$(CODEPOD_ARCHIVE)" CPCC_INCLUDE="$(CODEPOD_INCLUDE)" WASI_SDK_PATH="$(WASI_SDK_PATH)" python3 Tools/wasm/wasi.py configure-host --wasi-sdk "$(WASI_SDK_PATH)" --host-runner "$(CODEPOD_HOST_RUNNER)" -- \
		CC="$(CPCC)" \
		AR="$(CPAR)" \
		RANLIB="$(CPRANLIB)" \
		--config-cache
	cd $(WORK_DIR) && CPCC_ARCHIVE="$(CODEPOD_ARCHIVE)" CPCC_INCLUDE="$(CODEPOD_INCLUDE)" WASI_SDK_PATH="$(WASI_SDK_PATH)" python3 Tools/wasm/wasi.py make-host --host-triple wasm32-wasip1
	mkdir -p $(BUILD_DIR)
	cp $(WORK_DIR)/cross-build/wasm32-wasip1/python.wasm $@

$(UPSTREAM_ARTIFACT): $(UPSTREAM_WASI)
	mkdir -p $(BUILD_DIR)
	cp $(UPSTREAM_WASI) $@

run-print: $(UPSTREAM_ARTIFACT)
	cd $(UPSTREAM)/cross-build/wasm32-wasip1 && ./python.sh -c 'print(1 + 2)'

run-codepod-version: $(CODEPOD_ARTIFACT)
	$(CODEPOD_HOST_RUNNER) $(CODEPOD_ARTIFACT) --version

copy-fixtures: $(CODEPOD_ARTIFACT)
	mkdir -p $(FIXTURES)
	cp $(CODEPOD_ARTIFACT) $(FIXTURES)/cpython3.wasm
	mkdir -p $(FIXTURES)/cpython3-lib
	find $(FIXTURES)/cpython3-lib -mindepth 1 -maxdepth 1 -exec rm -rf {} +
	find $(WORK_DIR)/Lib -maxdepth 1 -type f -name '*.py' -exec cp {} $(FIXTURES)/cpython3-lib/ \;
	rsync -a --delete --delete-excluded --exclude='__pycache__/' --exclude='*.pyc' $(WORK_DIR)/Lib/encodings/ $(FIXTURES)/cpython3-lib/encodings/
	rsync -a --delete --delete-excluded --exclude='__pycache__/' --exclude='*.pyc' $(WORK_DIR)/Lib/importlib/ $(FIXTURES)/cpython3-lib/importlib/
	rsync -a --delete --delete-excluded --exclude='__pycache__/' --exclude='*.pyc' $(WORK_DIR)/Lib/collections/ $(FIXTURES)/cpython3-lib/collections/
	rsync -a --delete --delete-excluded --exclude='__pycache__/' --exclude='*.pyc' $(WORK_DIR)/Lib/re/ $(FIXTURES)/cpython3-lib/re/
	cd $(FIXTURES)/cpython3-lib && find . -type f ! -name '*.pyc' | sed 's#^\./##' | sort | python3 -c 'import json, sys; print(json.dumps([line.strip() for line in sys.stdin if line.strip()], indent=2))' > ../cpython3-lib-manifest.json

clean:
	rm -rf $(BUILD_DIR)
