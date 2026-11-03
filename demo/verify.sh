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
EXPECTED_FIXTURE_TESTS=4
EXPECTED_DEMO_TESTS=153
PATH_VALUE=${PATH-}

NODE_BIN=$(command -v node) || fail 'node is required on PATH'
command -v git >/dev/null 2>&1 || fail 'git is required on PATH'
git --version >/dev/null 2>&1 || fail 'git is installed but cannot run'

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

run_node_tests() {
  env -i \
    PATH="$PATH_VALUE" \
    "$NODE_BIN" --test --test-reporter=tap "$@"
}

run_test_suite() {
  suite_label=$1
  expected_tests=$2
  shift 2

  suite_output=''
  if suite_output=$(run_node_tests "$@" 2>&1); then
    suite_status=0
  else
    suite_status=$?
  fi
  printf '%s\n' "$suite_output"
  [ "$suite_status" -eq 0 ] ||
    fail "$suite_label tests exited with status $suite_status"

  suite_summary=$(printf '%s\n' "$suite_output" | awk '
    $1 == "#" && NF == 3 &&
      ($2 == "tests" || $2 == "pass" || $2 == "fail" ||
       $2 == "cancelled" || $2 == "skipped" || $2 == "todo") {
      values[$2] = $3
    }
    END {
      fields[1] = "tests"
      fields[2] = "pass"
      fields[3] = "fail"
      fields[4] = "cancelled"
      fields[5] = "skipped"
      fields[6] = "todo"
      for (position = 1; position <= 6; position += 1) {
        value = values[fields[position]]
        if (value !~ /^[0-9]+$/) exit 2
        printf "%s%s", position == 1 ? "" : " ", value
      }
      printf "\n"
    }
  ') || fail "$suite_label TAP summary is missing or invalid"

  set -- $suite_summary
  actual_tests=$1
  actual_pass=$2
  actual_fail=$3
  actual_cancelled=$4
  actual_skipped=$5
  actual_todo=$6
  if [ "$actual_tests" -ne "$expected_tests" ] ||
    [ "$actual_pass" -ne "$expected_tests" ] ||
    [ "$actual_fail" -ne 0 ] ||
    [ "$actual_cancelled" -ne 0 ] ||
    [ "$actual_skipped" -ne 0 ] ||
    [ "$actual_todo" -ne 0 ]; then
    fail "$suite_label TAP summary expected $expected_tests tests and passes; got tests=$actual_tests pass=$actual_pass fail=$actual_fail cancelled=$actual_cancelled skipped=$actual_skipped todo=$actual_todo"
  fi
  printf '%s tests: %s/%s passed\n' \
    "$suite_label" "$actual_pass" "$expected_tests"
}

set -- "$SCRIPT_DIR"/fixture/test/*.test.mjs
[ -f "$1" ] || fail 'no fixture test files found'
fixture_count=$#
run_test_suite Fixture "$EXPECTED_FIXTURE_TESTS" "$@"

set -- "$SCRIPT_DIR"/tests/*.test.mjs
[ -f "$1" ] || fail 'no demo test files found'
demo_count=$#
run_test_suite Demo "$EXPECTED_DEMO_TESTS" "$@"

syntax_count=0
for source_file in "$SCRIPT_DIR"/src/*.mjs "$SCRIPT_DIR"/public/*.js; do
  [ -f "$source_file" ] || fail "expected JavaScript source is missing: $source_file"
  env -i PATH="$PATH_VALUE" "$NODE_BIN" --check "$source_file"
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
