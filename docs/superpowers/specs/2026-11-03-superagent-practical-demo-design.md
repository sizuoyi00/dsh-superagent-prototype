# SuperAgent Practical Demo Design

## Purpose

Build a directly visible, repeatable demonstration of the dsh-superagent workflow for a mixed product, management, and technical audience. The default path must run without GitHub credentials, DSH, or an LLM provider, while still performing real repository work rather than only animating a dashboard.

The demo must make the boundary explicit: it demonstrates SuperAgent's harness and governance concepts with a deterministic local worker. It does not claim that a simulated GitHub source or deterministic worker is the production DSH runtime.

## Approaches considered

### 1. Live GitHub and DSH only

Run the published bundle exactly as documented with a dedicated GitHub user, DSH profile, model provider, and sandbox repository.

- Highest production fidelity.
- Blocked on this machine because DSH is absent and GitHub CLI is not authenticated.
- Poor fit for a reliable presentation because model, network, polling, and account state can fail at show time.

### 2. Static or mocked UI only

Render a panel with canned states and let the presenter click through the lifecycle.

- Fast and visually reliable.
- Does not prove branch creation, code changes, tests, commits, follow-up work, or persistence.
- Risks presenting a slideshow as an operational demo.

### 3. Hybrid local lab with an optional live upgrade path

Use a browser control room backed by a local HTTP service. The service applies SuperAgent-compatible lifecycle rules and runs a deterministic worker against an isolated Git repository. It creates a branch, changes production code and tests, runs tests, commits, produces a PR-style diff, accepts a follow-up comment on the same Ticket, and reloads persisted state. A doctor command separately reports what is missing for the real GitHub/DSH path.

- Runs now without secrets and remains reliable during a presentation.
- Demonstrates real repository side effects and recovery, not only UI states.
- Clearly labels simulated boundaries and provides the exact production upgrade steps.

This is the selected design.

## Audience story

The default seven-minute walkthrough answers four questions:

1. What wakes the agent? An explicit GitHub-style mention from an allowed operator.
2. Why is it allowed to act? The Trigger is evaluated under an explicit-only policy and becomes a durable Mandate and Ticket.
3. What does it really do? A single worker slot creates an isolated branch, fixes a boundary-condition bug, adds a test, runs the suite, commits, and exposes a PR-style patch.
4. What makes it more than one coding session? A PR follow-up resumes the same Ticket, and persisted state survives a service restart/reload.

## Architecture

```text
Browser control room
    |
    | JSON API
    v
Local demo server
    +-- immutable lifecycle reducer
    +-- JSON persistence store
    +-- deterministic worker adapter
    +-- live-mode preflight/doctor
             |
             v
    isolated local Git repository
      branch -> edit -> test -> commit -> PR-style diff
```

The lab is self-contained under `demo/`. It uses only Node.js standard-library APIs and Git, so it does not depend on the project's unpublished runtime packages. Runtime data is written under `demo/.runtime/`, which is ignored by Git.

### Domain layer

`demo/src/domain.mjs` owns pure, immutable state transitions. It models the visible SuperAgent concepts: Source, Trigger, Eval, Decision, Mandate, Ticket, Assignment, Report, Thread, and timeline event. Invalid actions return a typed conflict instead of silently changing state.

Allowed transition sequence:

```text
ready
  -> issue received / explicit Eval accepted / Ticket queued
  -> worker running
  -> awaiting review with local PR artifact
  -> follow-up received on subscribed PR Thread
  -> worker running on the same Ticket
  -> awaiting review with a second commit
  -> merged / Ticket ended
```

Reset is always available. Recovery reloads the last durable snapshot and appends a recovery event without creating a second Ticket or Assignment.

### Persistence layer

`demo/src/store.mjs` stores one versioned JSON document. Writes use a temporary file followed by rename. Reads validate the minimum schema and fail with an actionable error. The server never stores credentials.

### Repository worker

`demo/src/git-worker.mjs` creates an isolated repository from a small fixture owned by this demo. The fixture is intentionally broken only for the requested boundary case. The initial baseline tests pass; the requested new regression test fails before the fix, then the full suite passes after the fix.

The first assignment:

- creates `agent/demo-discount-boundary`;
- adds a failing test for a 100% discount;
- fixes the implementation;
- runs `node --test`;
- commits the result;
- returns commit metadata, test output, changed files, and a patch.

The follow-up assignment adds validation for non-finite inputs, its regression tests, and a second commit on the same branch. No shell string interpolation is used for untrusted request data; subprocesses receive argument arrays.

### HTTP and browser layer

`demo/src/server.mjs` binds to `127.0.0.1` by default and serves static assets plus a small JSON API:

- `GET /api/state`
- `POST /api/reset`
- `POST /api/issue`
- `POST /api/run`
- `POST /api/follow-up`
- `POST /api/recover`
- `POST /api/merge`
- `GET /api/doctor`

The browser shows:

- current mode and safety boundaries;
- a guided next-action button;
- lifecycle pipeline and timeline;
- Ticket, worker slot, branch, commits, test result, and PR patch;
- a side-by-side explanation of what is real locally and what the production runtime replaces;
- live-mode readiness from the doctor endpoint.

All mutating endpoints are POST-only, accept a bounded JSON body, and reject invalid lifecycle transitions with HTTP 409. Static path resolution cannot escape the demo public directory.

## Error handling

- Missing Git produces a failed assignment with captured stderr and keeps the Ticket visible for retry.
- Test, edit, or commit failure records a failed Report; it never presents a ready PR.
- A malformed persisted state file prevents mutation and instructs the operator to use reset.
- Concurrent run requests are guarded by one in-process worker lock; the second receives HTTP 409.
- Request bodies larger than 32 KiB receive HTTP 413.
- Unknown routes receive JSON 404 for API paths and a plain 404 for assets.
- Server logs contain operational details but no tokens or environment dumps.

## Testing strategy

Use Node's built-in test runner so the demo can be tested on a clean machine:

- unit tests for every valid and invalid lifecycle transition;
- store round-trip and corrupt-state tests;
- worker integration tests proving branch creation, red/green regression behavior, two commits on one branch, and a passing final suite;
- HTTP integration tests for the complete issue-to-merge flow, persistence recovery, validation, and conflicts;
- a smoke test that starts the server on an ephemeral port and fetches the browser assets.

The project-level source suite remains separate because it requires the DSH alpha dependencies. Demo verification must not be reported as proof that the full research prototype is production ready.

## Operation and handoff

The operator gets:

- `demo/start.sh` for one-command startup;
- `demo/verify.sh` for one-command automated acceptance;
- `demo/README.md` with a seven-minute walkthrough, API examples, troubleshooting, reset steps, and the live GitHub/DSH upgrade path;
- a browser URL printed at startup;
- no required secret, account, package installation, or external write.

## Acceptance criteria

1. `demo/verify.sh` passes from a clean checkout with supported Node and Git.
2. `demo/start.sh` prints a loopback URL and serves the control room.
3. A user can complete Issue -> Eval -> Ticket -> worker -> PR -> follow-up -> recovery -> merge from the browser.
4. The first and follow-up assignments create two real Git commits on one isolated branch and all fixture tests pass.
5. Reloading persisted state keeps the Ticket, branch, commits, and timeline.
6. The UI never labels the local source or worker as real GitHub/DSH.
7. The doctor output accurately reports the current machine's live-mode blockers.

## Out of scope

- Installing or configuring DSH without a provider selected by the operator.
- Creating or authenticating a GitHub account on the operator's behalf.
- Pushing to a third-party repository.
- Auto-merging a real pull request.
- Replacing the production dsh-superagent panel.
