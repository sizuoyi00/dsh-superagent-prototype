#!/bin/sh
set -eu

fail() {
  printf 'start.sh: %s\n' "$1" >&2
  exit 1
}

SCRIPT_DIR=$(CDPATH= cd -P "$(dirname "$0")" && pwd) ||
  fail 'cannot resolve the demo directory'
REPO_DIR=$(CDPATH= cd -P "$SCRIPT_DIR/.." && pwd) ||
  fail 'cannot resolve the repository directory'
SERVER_PATH=$SCRIPT_DIR/src/server.mjs
VERIFY_PATH=$SCRIPT_DIR/verify.sh

NODE_BIN=$(command -v node) || fail 'node is required on PATH'
command -v git >/dev/null 2>&1 || fail 'git is required on PATH'
git --version >/dev/null 2>&1 || fail 'git is installed but cannot run'
PATH_VALUE=${PATH-}

if ! env -i PATH="$PATH_VALUE" "$NODE_BIN" -e '
  const [major, minor, patch] = process.versions.node.split(".").map(Number);
  const supported =
    Number.isInteger(major) &&
    Number.isInteger(minor) &&
    Number.isInteger(patch) &&
    ((major === 22 && (minor > 19 || (minor === 19 && patch >= 0))) || major >= 24);
  process.exit(supported ? 0 : 1);
'; then
  fail 'Node.js ^22.19.0 or >=24.0.0 is required'
fi

DEMO_PORT=${DEMO_PORT-4173}
case $DEMO_PORT in
  ''|*[!0-9]*) fail 'DEMO_PORT must be an integer between 1 and 65535' ;;
esac
if ! [ "$DEMO_PORT" -ge 1 ] 2>/dev/null ||
  ! [ "$DEMO_PORT" -le 65535 ] 2>/dev/null; then
  fail 'DEMO_PORT must be an integer between 1 and 65535'
fi

DEMO_RUNTIME_DIR=${DEMO_RUNTIME_DIR-$SCRIPT_DIR/.runtime}
case $DEMO_RUNTIME_DIR in
  *[![:space:]]*) ;;
  *) fail 'DEMO_RUNTIME_DIR must be a non-empty path' ;;
esac
case $DEMO_RUNTIME_DIR in
  /*) ;;
  *) DEMO_RUNTIME_DIR=$REPO_DIR/$DEMO_RUNTIME_DIR ;;
esac

cd "$REPO_DIR" || fail 'cannot enter the repository directory'

printf 'Mode: 本地实战模式（生命周期模拟；Git/test/commit/patch 真实）\n'
printf 'Runtime: %s\n' "$DEMO_RUNTIME_DIR"
printf 'Stop: Ctrl+C\n'
printf 'Verify: %s\n' "$VERIFY_PATH"

exec env -i \
  PATH="$PATH_VALUE" \
  DEMO_PORT="$DEMO_PORT" \
  DEMO_RUNTIME_DIR="$DEMO_RUNTIME_DIR" \
  "$NODE_BIN" "$SERVER_PATH"
