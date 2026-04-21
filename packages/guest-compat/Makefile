# Build the guest-compat runtime archive + Tier 1 canaries. Every
# toolchain invocation goes through one of the cp* binaries:
# objects are compiled with `cpcc -c`, archives assembled with
# `cpar rcs`, canaries linked with `cpcc` (which --whole-archives
# libcodepod_guest_compat.a per §Override And Link Precedence).
#
# Targets:
#   make lib          — build libcodepod_guest_compat.a
#   make canaries     — build every conformance/c/*-canary.wasm
#   make all          — lib + canaries
#   make copy-fixtures — copy canary .wasm into the orchestrator fixtures dir
#   make clean

REPO_ROOT := $(shell cd ../.. && pwd)
FIXTURES := $(REPO_ROOT)/packages/orchestrator/src/platform/__tests__/fixtures
BUILD_DIR := build
INCLUDE := $(abspath include)
CANARY_DIR := conformance/c
CPCC := $(REPO_ROOT)/target/release/cpcc
CPAR := $(REPO_ROOT)/target/release/cpar

LIB := $(BUILD_DIR)/libcodepod_guest_compat.a
LIB_OBJS := \
  $(BUILD_DIR)/codepod_command.o \
  $(BUILD_DIR)/codepod_sched.o \
  $(BUILD_DIR)/codepod_signal.o \
  $(BUILD_DIR)/codepod_unistd.o \
  $(BUILD_DIR)/codepod_version.o

CANARY_NAMES := stdio sleep system popen affinity dup2 getgroups signal
CANARIES := $(addprefix $(BUILD_DIR)/,$(addsuffix -canary.wasm,$(CANARY_NAMES)))

.PHONY: all lib canaries copy-fixtures clean ensure-toolchain

all: lib canaries

$(BUILD_DIR):
	mkdir -p $(BUILD_DIR)

ensure-toolchain:
	@test -x $(CPCC) && test -x $(CPAR) || \
		(cd $(REPO_ROOT) && cargo build --release -p cpcc-toolchain)

# Objects compile through `cpcc -c`. The compat archive is not yet built
# when these rules fire and must not be injected; CPCC_ARCHIVE is
# explicitly unset so cpcc skips link-arg framing. This is safe because
# `-c` disables link anyway.
$(BUILD_DIR)/%.o: src/%.c include/codepod_compat.h src/codepod_runtime.h src/codepod_markers.h ensure-toolchain | $(BUILD_DIR)
	CPCC_ARCHIVE= CPCC_INCLUDE=$(INCLUDE) $(CPCC) -c $< -o $@

lib: $(LIB)

$(LIB): $(LIB_OBJS) ensure-toolchain | $(BUILD_DIR)
	$(CPAR) rcs $@ $(LIB_OBJS)

$(BUILD_DIR)/%-canary.wasm: $(CANARY_DIR)/%-canary.c $(LIB) ensure-toolchain | $(BUILD_DIR)
	CPCC_ARCHIVE=$(abspath $(LIB)) \
	CPCC_INCLUDE=$(INCLUDE) \
	CPCC_PRESERVE_PRE_OPT=$(abspath $(BUILD_DIR))/$*-canary.pre-opt.wasm \
	CPCC_NO_WASM_OPT=1 \
	$(CPCC) $< -o $@

canaries: $(CANARIES)

copy-fixtures: canaries
	@for n in $(CANARY_NAMES); do cp $(BUILD_DIR)/$$n-canary.wasm $(FIXTURES)/$$n-canary.wasm; done

clean:
	rm -rf $(BUILD_DIR)
