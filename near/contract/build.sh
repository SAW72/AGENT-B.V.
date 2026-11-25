#!/usr/bin/env bash
# Builds near/contract/res/agent_bv_policy.wasm with the pinned toolchain (rust-toolchain.toml).
set -euo pipefail
cd "$(dirname "$0")"
cargo build --release --target wasm32-unknown-unknown
mkdir -p res
cp "${CARGO_TARGET_DIR:-target}/wasm32-unknown-unknown/release/agent_bv_policy.wasm" res/
sha256sum res/agent_bv_policy.wasm
