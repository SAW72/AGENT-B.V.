#!/usr/bin/env bash
# Runs test/sandbox.test.mjs on a local nearcore 2.14.0 sandbox.
# near-workspaces 5.0.0 bundles nearcore 2.6.2, whose runtime rejects Wasm
# built by current rustc (reference-types). 2.14.0 matches NEAR testnet today.
set -euo pipefail
cd "$(dirname "$0")/.."
VER="${NEAR_SANDBOX_VERSION:-2.14.0}"
DIR="${NEAR_SANDBOX_DIR:-$PWD/../.sandbox/$VER}"
if [ ! -x "$DIR/near-sandbox" ]; then
  mkdir -p "$DIR"
  curl -sSfL "https://s3-us-west-1.amazonaws.com/build.nearprotocol.com/nearcore/Linux-x86_64/$VER/near-sandbox.tar.gz" \
    | tar xz --strip-components=1 -C "$DIR"
fi
"$DIR/near-sandbox" --version
NEAR_SANDBOX_BIN_PATH=1 NEAR_SANDBOX_BINARY_PATH="$DIR" \
  node --test --test-timeout=600000 test/sandbox.test.mjs
