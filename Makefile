.PHONY: test build build-rust build-sqlite build-ts npm wheel clean setup

# Development
test: build-ts
	bun test

build: build-rust build-sqlite build-ts

build-rust:
	cargo build --target wasm32-wasip1 --release

build-sqlite:
	cd packages/sqlite && make

build-ts:
	cd packages/kernel && bunx tsup

# npm package
npm: build-ts
	scripts/copy-wasm.sh packages/kernel/wasm
	cd packages/kernel && npm pack

# Python wheel (for current platform)
wheel:
	scripts/build-wheel.sh

# Setup
setup:
	git config core.hooksPath .githooks

# Cleanup
clean:
	rm -rf packages/kernel/dist packages/kernel/wasm
	rm -rf packages/python-sdk/src/wasmsand/_bundled
	rm -rf packages/python-sdk/dist packages/python-sdk/build
	rm -f packages/kernel/*.tgz
