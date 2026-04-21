# Build the phase-1 C compatibility canaries with the shared host-side
# `wasi-sdk` builder. Examples:
#   make
#   make copy-fixtures

REPO_ROOT := $(shell cd ../.. && pwd)
FIXTURES := $(REPO_ROOT)/packages/orchestrator/src/platform/__tests__/fixtures
BUILD := ../../scripts/build-c-port.sh
BUILD_DIR := build
BUILD_COMMON := --include include
BUILD_PREREQS := Makefile $(BUILD)

.PHONY: all clean copy-fixtures objects

all: stdio-canary.wasm sleep-canary.wasm system-canary.wasm popen-canary.wasm affinity-canary.wasm dup2-canary.wasm getgroups-canary.wasm signal-canary.wasm

$(BUILD_DIR):
	mkdir -p $(BUILD_DIR)

stdio-canary.wasm: examples/stdio_canary.c include/codepod_compat.h src/codepod_runtime.h $(BUILD_PREREQS)
	$(BUILD) $(BUILD_COMMON) --source $< --output $@

sleep-canary.wasm: examples/sleep_canary.c include/codepod_compat.h src/codepod_runtime.h $(BUILD_PREREQS)
	$(BUILD) $(BUILD_COMMON) --source $< --output $@

$(BUILD_DIR)/codepod_command.o: src/codepod_command.c include/codepod_compat.h src/codepod_runtime.h $(BUILD_PREREQS) | $(BUILD_DIR)
	$(BUILD) $(BUILD_COMMON) --compile-only --source $< --output $@

$(BUILD_DIR)/codepod_sched.o: src/codepod_sched.c include/sched.h $(BUILD_PREREQS) | $(BUILD_DIR)
	$(BUILD) $(BUILD_COMMON) --compile-only --source $< --output $@

$(BUILD_DIR)/codepod_unistd.o: src/codepod_unistd.c src/codepod_runtime.h $(BUILD_PREREQS) | $(BUILD_DIR)
	$(BUILD) $(BUILD_COMMON) --compile-only --source $< --output $@

$(BUILD_DIR)/codepod_signal.o: src/codepod_signal.c include/signal.h include/unistd.h $(BUILD_PREREQS) | $(BUILD_DIR)
	$(BUILD) $(BUILD_COMMON) --compile-only --source $< --output $@

$(BUILD_DIR)/codepod_version.o: src/codepod_version.c include/codepod_compat.h $(BUILD_PREREQS) | $(BUILD_DIR)
	$(BUILD) $(BUILD_COMMON) --compile-only --source $< --output $@

objects: $(BUILD_DIR)/codepod_command.o $(BUILD_DIR)/codepod_sched.o $(BUILD_DIR)/codepod_signal.o $(BUILD_DIR)/codepod_unistd.o $(BUILD_DIR)/codepod_version.o

system-canary.wasm: examples/system_canary.c include/codepod_compat.h $(BUILD_DIR)/codepod_command.o $(BUILD_PREREQS)
	$(BUILD) $(BUILD_COMMON) --input $(BUILD_DIR)/codepod_command.o --source $< --output $@

popen-canary.wasm: examples/popen_canary.c include/codepod_compat.h $(BUILD_DIR)/codepod_command.o $(BUILD_PREREQS)
	$(BUILD) $(BUILD_COMMON) --input $(BUILD_DIR)/codepod_command.o --source $< --output $@

affinity-canary.wasm: examples/affinity_canary.c include/sched.h $(BUILD_DIR)/codepod_sched.o $(BUILD_PREREQS)
	$(BUILD) $(BUILD_COMMON) --input $(BUILD_DIR)/codepod_sched.o --source $< --output $@

dup2-canary.wasm: examples/dup2_canary.c $(BUILD_DIR)/codepod_unistd.o $(BUILD_PREREQS)
	$(BUILD) $(BUILD_COMMON) --input $(BUILD_DIR)/codepod_unistd.o --source $< --output $@

getgroups-canary.wasm: examples/getgroups_canary.c $(BUILD_DIR)/codepod_unistd.o $(BUILD_PREREQS)
	$(BUILD) $(BUILD_COMMON) --input $(BUILD_DIR)/codepod_unistd.o --source $< --output $@

signal-canary.wasm: examples/signal_canary.c include/signal.h include/unistd.h $(BUILD_DIR)/codepod_signal.o $(BUILD_PREREQS)
	$(BUILD) $(BUILD_COMMON) --input $(BUILD_DIR)/codepod_signal.o --source $< --output $@

copy-fixtures: all
	cp stdio-canary.wasm $(FIXTURES)/stdio-canary.wasm
	cp sleep-canary.wasm $(FIXTURES)/sleep-canary.wasm
	cp system-canary.wasm $(FIXTURES)/system-canary.wasm
	cp popen-canary.wasm $(FIXTURES)/popen-canary.wasm
	cp affinity-canary.wasm $(FIXTURES)/affinity-canary.wasm
	cp dup2-canary.wasm $(FIXTURES)/dup2-canary.wasm
	cp getgroups-canary.wasm $(FIXTURES)/getgroups-canary.wasm
	cp signal-canary.wasm $(FIXTURES)/signal-canary.wasm

clean:
	rm -rf $(BUILD_DIR) stdio-canary.wasm sleep-canary.wasm system-canary.wasm popen-canary.wasm affinity-canary.wasm dup2-canary.wasm getgroups-canary.wasm signal-canary.wasm
