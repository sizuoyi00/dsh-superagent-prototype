#!/bin/sh
set -eu

fail() {
  printf 'verify.sh: %s\n' "$1" >&2
  exit 1
}

SCRIPT_DIR=$(CDPATH= cd -P "$(dirname "$0")" && pwd) ||
  fail 'cannot resolve the demo directory'
REPO_DIR=$(CDPATH= cd -P "$SCRIPT_DIR/.." && pwd) ||
  fail 'cannot resolve the repository directory'

NODE_BIN=$(command -v node) || fail 'node is required on PATH'
command -v git >/dev/null 2>&1 || fail 'git is required on PATH'
git --version >/dev/null 2>&1 || fail 'git is installed but cannot run'

if ! "$NODE_BIN" -e '
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

set -- "$SCRIPT_DIR"/fixture/test/*.test.mjs
[ -f "$1" ] || fail 'no fixture test files found'
fixture_count=$#
printf 'Fixture tests: %s file(s)\n' "$fixture_count"
"$NODE_BIN" --test "$@"

set -- "$SCRIPT_DIR"/tests/*.test.mjs
[ -f "$1" ] || fail 'no demo test files found'
demo_count=$#
printf 'Demo tests: %s file(s), fresh Node process\n' "$demo_count"
"$NODE_BIN" --test "$@"

syntax_count=0
for source_file in "$SCRIPT_DIR"/src/*.mjs "$SCRIPT_DIR"/public/*.js; do
  [ -f "$source_file" ] || fail "expected JavaScript source is missing: $source_file"
  "$NODE_BIN" --check "$source_file"
  syntax_count=$((syntax_count + 1))
done
printf 'Syntax checks: %s file(s)\n' "$syntax_count"

git -C "$REPO_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1 ||
  fail 'repository root is not a Git work tree'
git -C "$REPO_DIR" diff --check
printf 'Git whitespace check: complete (working tree cleanliness is not required)\n'

test_file_count=$((fixture_count + demo_count))
printf 'Verification complete: %s test file(s), %s syntax file(s), 0 failed commands\n' \
  "$test_file_count" "$syntax_count"
