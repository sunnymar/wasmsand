.PHONY: test build build-rust build-ts npm wheel clean setup

# Development
test: build-ts
	bun test

build: build-rust build-ts

build-rust:
	cargo build --target wasm32-wasip1 --release

build-ts:
	cd packages/orchestrator && bunx tsup

# npm package
npm: build-ts
	scripts/copy-wasm.sh packages/orchestrator/wasm
	cd packages/orchestrator && npm pack

# Python wheel (for current platform)
wheel:
	scripts/build-wheel.sh

# Setup
setup:
	git config core.hooksPath .githooks

# Cleanup
clean:
	rm -rf packages/orchestrator/dist packages/orchestrator/wasm
	rm -rf packages/python-sdk/src/wasmsand/_bundled
	rm -rf packages/python-sdk/dist packages/python-sdk/build
	rm -f packages/orchestrator/*.tgz
