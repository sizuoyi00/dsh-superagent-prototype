# SuperAgent Practical Demo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a one-command browser demo that visibly exercises SuperAgent's governed lifecycle while performing and persisting real Git work in an isolated local repository.

**Architecture:** A Node standard-library HTTP service composes a pure lifecycle reducer, an atomic JSON store, a deterministic Git worker, and a read-only live-mode doctor. A static browser control room drives the API and distinguishes local emulation from production DSH/GitHub behavior.

**Tech Stack:** Node.js 22+ ESM, `node:test`, Git CLI, HTML/CSS/vanilla JavaScript, POSIX shell wrappers.

---

## File map

- `demo/src/domain.mjs`: state factory, transition reducer, conflict type, view-safe state.
- `demo/src/store.mjs`: versioned atomic JSON persistence.
- `demo/src/process.mjs`: safe subprocess adapter with argument arrays and captured output.
- `demo/src/git-worker.mjs`: isolated repository initialization and two deterministic assignments.
- `demo/src/doctor.mjs`: read-only live GitHub/DSH readiness checks.
- `demo/src/server.mjs`: loopback HTTP server, API routing, request validation, static serving.
- `demo/public/index.html`: semantic control-room shell.
- `demo/public/app.js`: API client, rendering, guided actions, error presentation.
- `demo/public/styles.css`: responsive visual system.
- `demo/fixture/*`: tiny target application copied into runtime workspaces.
- `demo/tests/*.test.mjs`: unit and integration tests.
- `demo/start.sh`: safe one-command launch.
- `demo/verify.sh`: one-command acceptance.
- `demo/README.md`: walkthrough, architecture boundaries, API, troubleshooting, live upgrade.
- `.gitignore`: ignore demo runtime artifacts.

### Task 1: Lifecycle domain

**Files:**
- Create: `demo/src/domain.mjs`
- Create: `demo/tests/domain.test.mjs`

- [ ] **Step 1: Write failing tests for initial state and explicit Issue intake**

Assert that initial state is `ready`, and that `receiveIssue()` creates one Trigger, accepted Eval/Decision/Mandate, queued Ticket, subscribed Issue Thread, and one timeline sequence without mutating the previous state.

- [ ] **Step 2: Run the domain test and confirm RED**

Run: `node --test demo/tests/domain.test.mjs`

Expected: fail because `domain.mjs` does not exist.

- [ ] **Step 3: Implement minimal state factory, immutable transition, and `ConflictError`**

Export `createState`, `receiveIssue`, `startAssignment`, `completeAssignment`, `receiveFollowUp`, `recoverState`, `mergeTicket`, and `failAssignment`. Freeze or clone inputs at boundaries; never mutate prior state.

- [ ] **Step 4: Add failing tests for invalid ordering, follow-up ownership, recovery, failure, and merge**

Each transition must reject invalid phases with `ConflictError`. Follow-up must retain Ticket, branch, Session, and Thread identity. Recovery must append one event without duplicating work.

- [ ] **Step 5: Implement transitions and verify GREEN**

Run: `node --test demo/tests/domain.test.mjs`

Expected: all domain tests pass.

- [ ] **Step 6: Commit**

```bash
git add demo/src/domain.mjs demo/tests/domain.test.mjs
git commit -m "feat: model the superagent demo lifecycle"
```

### Task 2: Durable store

**Files:**
- Create: `demo/src/store.mjs`
- Create: `demo/tests/store.test.mjs`

- [ ] **Step 1: Write failing store tests**

Cover missing-file initialization, save/load round trip, object independence after load, version validation, corrupt JSON, and atomic temp-file cleanup.

- [ ] **Step 2: Confirm RED**

Run: `node --test demo/tests/store.test.mjs`

- [ ] **Step 3: Implement the minimal `JsonStore`**

Use `mkdir`, `readFile`, `writeFile`, and `rename`. The temp file must live next to the state file. Surface errors with the state path and reset guidance.

- [ ] **Step 4: Verify GREEN and commit**

Run: `node --test demo/tests/store.test.mjs`

```bash
git add demo/src/store.mjs demo/tests/store.test.mjs
git commit -m "feat: persist demo state atomically"
```

### Task 3: Real Git worker

**Files:**
- Create: `demo/src/process.mjs`
- Create: `demo/src/git-worker.mjs`
- Create: `demo/fixture/package.json`
- Create: `demo/fixture/src/discount.mjs`
- Create: `demo/fixture/test/discount.test.mjs`
- Create: `demo/fixture/README.md`
- Create: `demo/tests/git-worker.test.mjs`

- [ ] **Step 1: Create fixture and failing worker test**

The baseline fixture test passes. The worker test expects initialization to create a Git repository with an initial commit, then expects assignment one to record a red regression run, apply the 100% discount fix, pass all tests, and commit on `agent/demo-discount-boundary`.

- [ ] **Step 2: Confirm RED**

Run: `node --test demo/tests/git-worker.test.mjs`

- [ ] **Step 3: Implement safe subprocess and repository initialization**

Use `spawn`/`execFile` argument arrays, bounded captured output, explicit cwd, and no shell. Copy the fixture recursively, configure repository-local demo author identity, and create the initial commit.

- [ ] **Step 4: Implement assignment one with demonstrated RED -> GREEN**

Write the new regression test first, run it and require failure, apply the implementation patch, run the full suite, commit, and return branch/commit/files/patch/test evidence.

- [ ] **Step 5: Add failing follow-up test**

Expect assignment two to add non-finite input validation and tests, produce a second commit on the same branch, and keep the suite green.

- [ ] **Step 6: Implement follow-up, verify, and commit**

Run: `node --test demo/tests/git-worker.test.mjs`

```bash
git add demo/src/process.mjs demo/src/git-worker.mjs demo/fixture demo/tests/git-worker.test.mjs
git commit -m "feat: execute real git work in the demo lab"
```

### Task 4: Live-mode doctor

**Files:**
- Create: `demo/src/doctor.mjs`
- Create: `demo/tests/doctor.test.mjs`

- [ ] **Step 1: Write failing tests with an injected command probe**

Cover ready and blocked results for Node, Git, `gh`, GitHub authentication, DSH, and local source checkout. Ensure no token or environment value is returned.

- [ ] **Step 2: Confirm RED**

Run: `node --test demo/tests/doctor.test.mjs`

- [ ] **Step 3: Implement read-only readiness checks**

Return `{ ready, checks, blockers }`. The actual machine is expected to report missing DSH and unauthenticated GitHub without failing the local demo.

- [ ] **Step 4: Verify and commit**

Run: `node --test demo/tests/doctor.test.mjs`

```bash
git add demo/src/doctor.mjs demo/tests/doctor.test.mjs
git commit -m "feat: report live superagent readiness"
```

### Task 5: HTTP API

**Files:**
- Create: `demo/src/server.mjs`
- Create: `demo/tests/server.test.mjs`

- [ ] **Step 1: Write failing smoke and validation tests**

Start the app on port `0`. Test `GET /api/state`, unknown API 404, POST-only mutations, JSON content type, 32 KiB body limit, invalid JSON, and static asset traversal rejection.

- [ ] **Step 2: Confirm RED**

Run: `node --test demo/tests/server.test.mjs`

- [ ] **Step 3: Implement server factory and safe router**

Export `createDemoServer({ runtimeDir, publicDir, fixtureDir, doctor })`. Bind only in the CLI entrypoint. Serialize errors as `{ error, code }` without stack traces.

- [ ] **Step 4: Add failing complete-flow test**

Drive reset -> issue -> run -> follow-up -> run -> recover -> merge. Assert two commits, one Ticket, stable Session/branch, green tests, persisted recovery, and ended outcome.

- [ ] **Step 5: Implement lifecycle endpoints and worker lock**

Persist each durable transition. A run failure must call `failAssignment` and remain visible. A concurrent run returns 409.

- [ ] **Step 6: Verify and commit**

Run: `node --test demo/tests/server.test.mjs`

```bash
git add demo/src/server.mjs demo/tests/server.test.mjs
git commit -m "feat: expose the demo lifecycle API"
```

### Task 6: Browser control room

**Files:**
- Create: `demo/public/index.html`
- Create: `demo/public/app.js`
- Create: `demo/public/styles.css`
- Create: `demo/tests/ui-smoke.test.mjs`

- [ ] **Step 1: Write failing asset and semantic smoke tests**

Fetch `/`, `/app.js`, and `/styles.css`. Assert page title, local-mode disclosure, lifecycle region, guided action, Ticket details, patch output, doctor region, responsive viewport metadata, and accessible live status.

- [ ] **Step 2: Confirm RED**

Run: `node --test demo/tests/ui-smoke.test.mjs`

- [ ] **Step 3: Build the semantic HTML shell and visual system**

Use a clear operations-dashboard hierarchy, high-contrast status colors, responsive layout, keyboard-focus styles, reduced-motion support, and no remote assets.

- [ ] **Step 4: Implement browser state rendering and guided actions**

The primary button chooses the only valid next action. Secondary controls expose reset, recovery, and doctor refresh. Render escaped text via DOM APIs, never `innerHTML` with API data.

- [ ] **Step 5: Verify and commit**

Run: `node --test demo/tests/ui-smoke.test.mjs`

```bash
git add demo/public demo/tests/ui-smoke.test.mjs
git commit -m "feat: add the superagent demo control room"
```

### Task 7: Operator scripts and manual

**Files:**
- Create: `demo/start.sh`
- Create: `demo/verify.sh`
- Create: `demo/README.md`
- Modify: `.gitignore`
- Create: `demo/tests/scripts.test.mjs`

- [ ] **Step 1: Write failing script contract tests**

Assert executable scripts use strict shell mode, resolve their own directory, accept `DEMO_PORT` and `DEMO_RUNTIME_DIR`, bind loopback by default, and do not delete paths outside the resolved demo runtime.

- [ ] **Step 2: Confirm RED**

Run: `node --test demo/tests/scripts.test.mjs`

- [ ] **Step 3: Implement scripts and runtime ignore rule**

`start.sh` prints the browser URL and `Ctrl+C` stop instruction. `verify.sh` checks Node/Git, runs all demo tests, verifies a clean fixture result, and exits non-zero on failure.

- [ ] **Step 4: Write the operation manual**

Include quick start, exact seven-minute script, what is real vs simulated, state reset, API examples, files produced, troubleshooting, security boundaries, and the exact prerequisites for a real GitHub/DSH deployment.

- [ ] **Step 5: Verify and commit**

Run: `node --test demo/tests/scripts.test.mjs`

```bash
git add .gitignore demo/start.sh demo/verify.sh demo/README.md demo/tests/scripts.test.mjs
git commit -m "docs: add demo startup and operation guide"
```

### Task 8: Full verification and review

**Files:**
- Modify only files required by review findings.

- [ ] **Step 1: Run focused and full demo verification**

Run:

```bash
demo/verify.sh
git diff --check main...HEAD
```

Expected: zero test failures and no whitespace errors.

- [ ] **Step 2: Start the server and perform browser/API acceptance**

Start on an ephemeral available loopback port, fetch the page, drive the full API flow, inspect the generated repository, run its tests, and stop the server cleanly.

- [ ] **Step 3: Run security and code review**

Review subprocess arguments, path containment, body limits, HTML rendering, persistence paths, error disclosure, and shell scripts. Fix all critical and important findings.

- [ ] **Step 4: Re-run fresh verification after fixes**

Run `demo/verify.sh` and `git diff --check main...HEAD` again. Record actual counts and blockers; do not infer success from earlier runs.

- [ ] **Step 5: Integrate into the user's current branch**

Cherry-pick only the Demo branch commits. Verify that pre-existing modified and untracked research files remain unchanged. Re-run `demo/verify.sh` in the user's workspace.
