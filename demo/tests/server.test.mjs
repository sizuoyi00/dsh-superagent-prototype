import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  lstat,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createDemoServer } from '../src/server.mjs';
import { runProcess } from '../src/process.mjs';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const fixtureDirectory = resolve(testDirectory, '../fixture');
const serverModulePath = resolve(testDirectory, '../src/server.mjs');

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
}

async function createHarness(t, options = {}) {
  const rootDirectory = await mkdtemp(join(tmpdir(), 'superagent-server-'));
  const runtimeDir = join(rootDirectory, 'runtime');
  const publicDir = join(rootDirectory, 'public');
  await mkdir(publicDir, { recursive: true });
  await writeFile(join(publicDir, 'asset.txt'), 'local asset\n', 'utf8');

  const server = createDemoServer({
    runtimeDir,
    publicDir,
    fixtureDir: fixtureDirectory,
    doctor: async () => ({ ready: true, checks: [], blockers: [] }),
    ...options,
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  t.after(async () => {
    await closeServer(server);
    await rm(rootDirectory, { recursive: true, force: true });
  });
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    publicDir,
    rootDirectory,
    runtimeDir,
    server,
  };
}

async function readJson(response) {
  return JSON.parse(await response.text());
}

async function postJson(baseUrl, pathname, body = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { response, value: await readJson(response) };
}

async function rawRequest(baseUrl, options = {}) {
  const target = new URL(baseUrl);
  return new Promise((resolveRequest, rejectRequest) => {
    const outgoing = request(
      {
        hostname: target.hostname,
        port: target.port,
        method: options.method ?? 'GET',
        path: options.path ?? '/',
        headers: options.headers,
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          resolveRequest({
            body: Buffer.concat(chunks).toString('utf8'),
            headers: response.headers,
            status: response.statusCode,
          });
        });
      },
    );
    outgoing.on('error', rejectRequest);
    if (options.body !== undefined) outgoing.write(options.body);
    outgoing.end();
  });
}

test('starts on an ephemeral loopback port and returns durable state', async (t) => {
  const { baseUrl } = await createHarness(t);

  const response = await fetch(`${baseUrl}/api/state`);
  const state = await readJson(response);

  assert.equal(response.status, 200);
  assert.equal(state.phase, 'ready');
  assert.equal(state.schemaVersion, 1);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.equal(
    response.headers.get('content-security-policy'),
    "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'",
  );
});

test('defaults server.listen to loopback and rejects non-loopback binding', async (t) => {
  const rootDirectory = await mkdtemp(join(tmpdir(), 'superagent-listen-'));
  const publicDir = join(rootDirectory, 'public');
  await mkdir(publicDir);
  const server = createDemoServer({
    runtimeDir: join(rootDirectory, 'runtime'),
    publicDir,
    fixtureDir: fixtureDirectory,
  });
  t.after(async () => {
    await closeServer(server);
    await rm(rootDirectory, { recursive: true, force: true });
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, resolveListen);
  });
  assert.equal(server.address().address, '127.0.0.1');
  await closeServer(server);

  assert.throws(
    () => server.listen(0, '0.0.0.0'),
    /loopback/i,
  );
});

test('CLI rejects a blank DEMO_RUNTIME_DIR without writing into cwd', async (t) => {
  const workingDirectory = await mkdtemp(join(tmpdir(), 'superagent-cli-'));
  const sentinelPath = join(workingDirectory, 'sentinel.txt');
  await writeFile(sentinelPath, 'unchanged\n', 'utf8');
  t.after(() => rm(workingDirectory, { recursive: true, force: true }));

  const result = await runProcess(process.execPath, [serverModulePath], {
    cwd: workingDirectory,
    env: {
      ...process.env,
      DEMO_RUNTIME_DIR: '   ',
    },
    timeoutMs: 750,
    maxOutputBytes: 16 * 1024,
  });

  assert.equal(result.timedOut, false);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /DEMO_RUNTIME_DIR/);
  assert.deepEqual(await readdir(workingDirectory), ['sentinel.txt']);
  assert.equal(await readFile(sentinelPath, 'utf8'), 'unchanged\n');
});

test('returns the injected live-readiness doctor result', async (t) => {
  let callCount = 0;
  const expected = {
    ready: false,
    checks: [{ id: 'dsh', status: 'blocked' }],
    blockers: [{ id: 'dsh', status: 'blocked' }],
  };
  const { baseUrl } = await createHarness(t, {
    doctor: async () => {
      callCount += 1;
      return expected;
    },
  });

  const response = await fetch(`${baseUrl}/api/doctor`);

  assert.equal(response.status, 200);
  assert.deepEqual(await readJson(response), expected);
  assert.equal(callCount, 1);
});

test('persists one Ticket through two real assignments, recovery, and merge', async (t) => {
  const harness = await createHarness(t);

  const reset = await postJson(harness.baseUrl, '/api/reset');
  assert.equal(reset.response.status, 200);
  assert.equal(reset.value.phase, 'ready');

  const issued = await postJson(harness.baseUrl, '/api/issue', {
    title: 'Allow a complete discount',
    requester: 'qa-reviewer',
    text: 'A 100 percent discount must return a zero total.',
  });
  assert.equal(issued.response.status, 200);
  assert.equal(issued.value.phase, 'queued');
  assert.equal(issued.value.tickets.length, 1);
  assert.equal(issued.value.triggers[0].author, 'qa-reviewer');
  assert.equal(
    issued.value.triggers[0].body,
    'A 100 percent discount must return a zero total.',
  );
  const originalTicket = issued.value.tickets[0];

  const firstRun = await postJson(harness.baseUrl, '/api/run');
  assert.equal(firstRun.response.status, 200);
  assert.equal(firstRun.value.phase, 'awaiting_review');
  assert.equal(firstRun.value.tickets.length, 1);
  assert.equal(firstRun.value.tickets[0].branch, originalTicket.branch);
  assert.equal(firstRun.value.tickets[0].sessionId, originalTicket.sessionId);
  assert.equal(firstRun.value.tickets[0].commits.length, 1);
  assert.equal(firstRun.value.assignments[0].result.tests.ok, true);

  const followedUp = await postJson(harness.baseUrl, '/api/follow-up', {
    requester: 'maintainer',
    text: 'Reject non-finite inputs and document that boundary.',
  });
  assert.equal(followedUp.response.status, 200);
  assert.equal(followedUp.value.phase, 'queued');
  assert.equal(followedUp.value.tickets.length, 1);
  assert.equal(followedUp.value.tickets[0].id, originalTicket.id);
  assert.equal(followedUp.value.tickets[0].branch, originalTicket.branch);
  assert.equal(followedUp.value.tickets[0].sessionId, originalTicket.sessionId);
  assert.equal(followedUp.value.triggers.at(-1).author, 'maintainer');
  assert.equal(
    followedUp.value.triggers.at(-1).body,
    'Reject non-finite inputs and document that boundary.',
  );

  const secondRun = await postJson(harness.baseUrl, '/api/run');
  assert.equal(secondRun.response.status, 200);
  assert.equal(secondRun.value.phase, 'awaiting_review');
  assert.equal(secondRun.value.tickets.length, 1);
  assert.equal(secondRun.value.assignments.length, 2);
  assert.equal(secondRun.value.assignments[1].result.tests.ok, true);
  assert.equal(secondRun.value.tickets[0].commits.length, 2);
  assert.equal(
    new Set(secondRun.value.tickets[0].commits.map(({ hash }) => hash)).size,
    2,
  );

  const persistedBeforeRestart = JSON.parse(
    await readFile(join(harness.runtimeDir, 'state.json'), 'utf8'),
  );
  assert.deepEqual(persistedBeforeRestart, secondRun.value);

  await closeServer(harness.server);
  const restartedServer = createDemoServer({
    runtimeDir: harness.runtimeDir,
    publicDir: harness.publicDir,
    fixtureDir: fixtureDirectory,
    doctor: async () => ({ ready: true, checks: [], blockers: [] }),
  });
  await new Promise((resolveListen, rejectListen) => {
    restartedServer.once('error', rejectListen);
    restartedServer.listen(0, '127.0.0.1', resolveListen);
  });
  t.after(() => closeServer(restartedServer));
  const restartedAddress = restartedServer.address();
  const restartedBaseUrl = `http://127.0.0.1:${restartedAddress.port}`;

  const recovered = await postJson(restartedBaseUrl, '/api/recover');
  assert.equal(recovered.response.status, 200);
  assert.equal(recovered.value.phase, 'awaiting_review');
  assert.equal(recovered.value.tickets.length, 1);
  assert.equal(recovered.value.tickets[0].branch, originalTicket.branch);
  assert.equal(recovered.value.tickets[0].sessionId, originalTicket.sessionId);
  assert.equal(recovered.value.tickets[0].commits.length, 2);
  assert.equal(recovered.value.timeline.at(-1).type, 'state.recovered');

  const merged = await postJson(restartedBaseUrl, '/api/merge');
  assert.equal(merged.response.status, 200);
  assert.equal(merged.value.phase, 'merged');
  assert.equal(merged.value.tickets.length, 1);
  assert.equal(merged.value.tickets[0].status, 'ended');
  assert.equal(merged.value.tickets[0].outcome, 'merged');
  assert.equal(merged.value.tickets[0].branch, originalTicket.branch);
  assert.equal(merged.value.tickets[0].sessionId, originalTicket.sessionId);
  assert.equal(merged.value.tickets[0].commits.length, 2);

  const persistedAfterMerge = JSON.parse(
    await readFile(join(harness.runtimeDir, 'state.json'), 'utf8'),
  );
  assert.deepEqual(persistedAfterMerge, merged.value);
});

test('persists a visible safe failure when the real worker cannot run', async (t) => {
  const harness = await createHarness(t);
  await postJson(harness.baseUrl, '/api/reset');
  await postJson(harness.baseUrl, '/api/issue', {
    title: 'Break the controlled worker target',
    requester: 'failure-test',
    text: 'Exercise the visible failure path.',
  });
  await rm(join(harness.runtimeDir, 'repo', 'src', 'discount.mjs'));

  const failedRun = await postJson(harness.baseUrl, '/api/run');
  const stateResponse = await fetch(`${harness.baseUrl}/api/state`);
  const failedState = await readJson(stateResponse);

  assert.equal(failedRun.response.status, 500);
  assert.deepEqual(failedRun.value, {
    error: 'The local worker could not complete the assignment',
    code: 'ASSIGNMENT_FAILED',
  });
  assert.equal(JSON.stringify(failedRun.value).includes(harness.runtimeDir), false);
  assert.equal(Object.hasOwn(failedRun.value, 'stack'), false);
  assert.equal(failedState.phase, 'failed');
  assert.equal(failedState.assignments.at(-1).status, 'failed');
  assert.equal(failedState.reports.at(-1).visible, true);
  assert.equal(
    failedState.reports.at(-1).summary,
    'The local worker could not complete the assignment',
  );
  const persisted = JSON.parse(
    await readFile(join(harness.runtimeDir, 'state.json'), 'utf8'),
  );
  assert.deepEqual(persisted, failedState);
});

test('reset replaces only runtimeDir/repo and never follows it outside', async (t) => {
  const harness = await createHarness(t);
  const externalDirectory = join(harness.rootDirectory, 'external-repository');
  const runtimeSentinel = join(harness.runtimeDir, 'keep.txt');
  const externalSentinel = join(externalDirectory, 'outside.txt');
  await mkdir(harness.runtimeDir, { recursive: true });
  await mkdir(externalDirectory);
  await writeFile(runtimeSentinel, 'keep\n', 'utf8');
  await writeFile(externalSentinel, 'outside\n', 'utf8');
  await symlink(externalDirectory, join(harness.runtimeDir, 'repo'));

  const reset = await postJson(harness.baseUrl, '/api/reset');

  assert.equal(reset.response.status, 200);
  assert.equal(await readFile(runtimeSentinel, 'utf8'), 'keep\n');
  assert.equal(await readFile(externalSentinel, 'utf8'), 'outside\n');
  assert.equal((await lstat(harness.runtimeDir)).isDirectory(), true);
  assert.equal((await lstat(join(harness.runtimeDir, 'repo'))).isDirectory(), true);
});

test('rejects state and reset after runtimeDir is replaced by an external symlink', async (t) => {
  const harness = await createHarness(t);
  const externalDirectory = join(harness.rootDirectory, 'external-runtime');
  await mkdir(externalDirectory);
  await mkdir(harness.runtimeDir, { recursive: true });
  await rm(harness.runtimeDir, { recursive: true });
  await symlink(externalDirectory, harness.runtimeDir);

  const stateResponse = await fetch(`${harness.baseUrl}/api/state`);
  const stateError = await readJson(stateResponse);
  const reset = await postJson(harness.baseUrl, '/api/reset');

  assert.equal(stateResponse.status, 409);
  assert.deepEqual(stateError, {
    error: 'Runtime directory identity changed; restart the demo safely',
    code: 'RUNTIME_INTEGRITY_ERROR',
  });
  assert.equal(reset.response.status, 409);
  assert.deepEqual(reset.value, stateError);
  assert.deepEqual(await readdir(externalDirectory), []);
});

test('rejects a concurrent run while one real worker assignment is active', async (t) => {
  const harness = await createHarness(t);
  await postJson(harness.baseUrl, '/api/reset');
  await postJson(harness.baseUrl, '/api/issue', {
    title: 'Serialize worker execution',
    requester: 'concurrency-test',
    text: 'Only one assignment may use the isolated repository at a time.',
  });

  const results = await Promise.all([
    postJson(harness.baseUrl, '/api/run'),
    postJson(harness.baseUrl, '/api/run'),
  ]);
  const successful = results.find(({ response }) => response.status === 200);
  const conflicted = results.find(({ response }) => response.status === 409);

  assert.ok(successful);
  assert.ok(conflicted);
  assert.deepEqual(conflicted.value, {
    error: 'Another assignment is already running',
    code: 'RUN_IN_PROGRESS',
  });
  assert.equal(successful.value.phase, 'awaiting_review');
  assert.equal(successful.value.assignments.length, 1);
  assert.equal(successful.value.tickets[0].commits.length, 1);
});

test('maps corrupt persisted state to STORE_ERROR and reset rebuilds it', async (t) => {
  const harness = await createHarness(t);
  await writeFile(join(harness.runtimeDir, 'state.json'), '{broken', 'utf8');

  const stateResponse = await fetch(`${harness.baseUrl}/api/state`);
  const stateError = await readJson(stateResponse);
  const issue = await postJson(harness.baseUrl, '/api/issue', {
    title: 'Must not mutate corrupt state',
    requester: 'store-test',
    text: 'Use reset before accepting this Issue.',
  });

  assert.equal(stateResponse.status, 500);
  assert.deepEqual(stateError, {
    error: 'Unable to load demo state. Use reset to rebuild the demo state.',
    code: 'STORE_ERROR',
  });
  assert.equal(JSON.stringify(stateError).includes(harness.runtimeDir), false);
  assert.equal(issue.response.status, 500);
  assert.deepEqual(issue.value, stateError);

  const reset = await postJson(harness.baseUrl, '/api/reset');
  assert.equal(reset.response.status, 200);
  assert.equal(reset.value.phase, 'ready');
  assert.deepEqual(
    JSON.parse(await readFile(join(harness.runtimeDir, 'state.json'), 'utf8')),
    reset.value,
  );
});

test('maps a low-level StoreError without exposing its state path', async (t) => {
  const harness = await createHarness(t);
  const externalDirectory = join(harness.rootDirectory, 'external-state-dir');
  await mkdir(externalDirectory);
  await symlink(externalDirectory, join(harness.runtimeDir, 'state.json'));

  const response = await fetch(`${harness.baseUrl}/api/state`);
  const error = await readJson(response);

  assert.equal(response.status, 500);
  assert.deepEqual(error, {
    error: 'Unable to load demo state. Use reset to rebuild the demo state.',
    code: 'STORE_ERROR',
  });
  assert.equal(JSON.stringify(error).includes(harness.runtimeDir), false);
  assert.equal(JSON.stringify(error).includes(externalDirectory), false);
});

test('returns JSON 404 and endpoint-specific 405 responses', async (t) => {
  const { baseUrl } = await createHarness(t);

  const unknown = await fetch(`${baseUrl}/api/missing`);
  const malformed = await rawRequest(baseUrl, { path: '/api/%ZZ' });
  const resetGet = await fetch(`${baseUrl}/api/reset`);
  const statePost = await fetch(`${baseUrl}/api/state`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });

  assert.equal(unknown.status, 404);
  assert.deepEqual(await readJson(unknown), {
    error: 'Not found',
    code: 'NOT_FOUND',
  });
  assert.equal(malformed.status, 404);
  assert.deepEqual(JSON.parse(malformed.body), {
    error: 'Not found',
    code: 'NOT_FOUND',
  });
  assert.equal(resetGet.status, 405);
  assert.equal(resetGet.headers.get('allow'), 'POST');
  assert.deepEqual(await readJson(resetGet), {
    error: 'Method not allowed',
    code: 'METHOD_NOT_ALLOWED',
  });
  assert.equal(statePost.status, 405);
  assert.equal(statePost.headers.get('allow'), 'GET');
});

test('enforces JSON content type, syntax, size, and field lengths', async (t) => {
  const { baseUrl } = await createHarness(t);

  const wrongType = await fetch(`${baseUrl}/api/issue`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: '{}',
  });
  const invalidJson = await fetch(`${baseUrl}/api/issue`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{',
  });
  const oversized = await fetch(`${baseUrl}/api/issue`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'x'.repeat(33 * 1024) }),
  });
  const invalidField = await fetch(`${baseUrl}/api/issue`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      title: 'x'.repeat(161),
      requester: 'demo-user',
      text: 'Please fix the discount boundary.',
    }),
  });

  assert.equal(wrongType.status, 415);
  assert.equal((await readJson(wrongType)).code, 'UNSUPPORTED_MEDIA_TYPE');
  assert.equal(invalidJson.status, 400);
  assert.equal((await readJson(invalidJson)).code, 'INVALID_JSON');
  assert.equal(oversized.status, 413);
  assert.equal((await readJson(oversized)).code, 'BODY_TOO_LARGE');
  assert.equal(invalidField.status, 400);
  assert.equal((await readJson(invalidField)).code, 'VALIDATION_ERROR');

  for (const invalidBody of [
    { title: 'x'.repeat(161), requester: 'requester', text: 'text' },
    { title: 'title', requester: 'x'.repeat(81), text: 'text' },
    { title: 'title', requester: 'requester', text: 'x'.repeat(4_001) },
  ]) {
    const response = await fetch(`${baseUrl}/api/issue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(invalidBody),
    });
    assert.equal(response.status, 400);
    assert.equal((await readJson(response)).code, 'VALIDATION_ERROR');
  }
});

test('maps invalid lifecycle transitions to a JSON conflict', async (t) => {
  const { baseUrl } = await createHarness(t);

  const merge = await postJson(baseUrl, '/api/merge');

  assert.equal(merge.response.status, 409);
  assert.equal(merge.value.code, 'CONFLICT');
  assert.equal(Object.hasOwn(merge.value, 'stack'), false);
});

test('accepts only loopback Host values and same-origin Origin values', async (t) => {
  const { baseUrl } = await createHarness(t);
  const target = new URL(baseUrl);

  const invalidHost = await rawRequest(baseUrl, {
    path: '/api/state',
    headers: { host: 'example.com' },
  });
  const malformedLoopbackHost = await rawRequest(baseUrl, {
    path: '/api/state',
    headers: { host: `${target.host}#fragment` },
  });
  const invalidOrigin = await rawRequest(baseUrl, {
    path: '/api/state',
    headers: {
      host: target.host,
      origin: 'http://example.com',
    },
  });
  const sameOrigin = await rawRequest(baseUrl, {
    path: '/api/state',
    headers: {
      host: target.host,
      origin: target.origin,
    },
  });
  const malformedSameOrigin = await rawRequest(baseUrl, {
    path: '/api/state',
    headers: {
      host: target.host,
      origin: `${target.origin}/path`,
    },
  });

  assert.equal(invalidHost.status, 403);
  assert.equal(JSON.parse(invalidHost.body).code, 'INVALID_HOST');
  assert.equal(malformedLoopbackHost.status, 403);
  assert.equal(JSON.parse(malformedLoopbackHost.body).code, 'INVALID_HOST');
  assert.equal(invalidOrigin.status, 403);
  assert.equal(JSON.parse(invalidOrigin.body).code, 'INVALID_ORIGIN');
  assert.equal(sameOrigin.status, 200);
  assert.equal(malformedSameOrigin.status, 403);
  assert.equal(JSON.parse(malformedSameOrigin.body).code, 'INVALID_ORIGIN');
});

test('serves local static files but rejects methods and path traversal', async (t) => {
  const harness = await createHarness(t);
  const externalFile = join(harness.rootDirectory, 'secret.txt');
  await writeFile(externalFile, 'secret\n', 'utf8');
  await symlink(externalFile, join(harness.publicDir, 'escape.txt'));

  const asset = await fetch(`${harness.baseUrl}/asset.txt`);
  const head = await fetch(`${harness.baseUrl}/asset.txt`, { method: 'HEAD' });
  const wrongMethod = await fetch(`${harness.baseUrl}/asset.txt`, {
    method: 'POST',
  });
  const traversal = await rawRequest(harness.baseUrl, {
    path: '/%2e%2e/secret.txt',
  });
  const backslashTraversal = await rawRequest(harness.baseUrl, {
    path: '/%5c..%5csecret.txt',
  });
  const symlinkEscape = await fetch(`${harness.baseUrl}/escape.txt`);
  const unknown = await fetch(`${harness.baseUrl}/missing.txt`);

  assert.equal(asset.status, 200);
  assert.equal(await asset.text(), 'local asset\n');
  assert.match(asset.headers.get('content-type'), /^text\/plain/);
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get('allow'), 'GET, HEAD');
  assert.equal(traversal.status, 404);
  assert.equal(backslashTraversal.status, 404);
  assert.equal(symlinkEscape.status, 404);
  assert.equal(unknown.status, 404);
});

test('rejects dangerous nesting between runtime, public, and fixture paths', async (t) => {
  const rootDirectory = await mkdtemp(join(tmpdir(), 'superagent-layout-'));
  t.after(() => rm(rootDirectory, { recursive: true, force: true }));
  const publicDir = join(rootDirectory, 'public');
  const fixtureAlias = join(rootDirectory, 'fixture-alias');
  await mkdir(publicDir, { recursive: true });
  await symlink(fixtureDirectory, fixtureAlias);

  assert.throws(
    () => createDemoServer({
      runtimeDir: join(publicDir, 'runtime'),
      publicDir,
      fixtureDir: fixtureDirectory,
    }),
    /separate directory trees/i,
  );
  assert.throws(
    () => createDemoServer({
      runtimeDir: join(rootDirectory, 'runtime'),
      publicDir: fixtureAlias,
      fixtureDir: fixtureDirectory,
    }),
    /separate directory trees/i,
  );
});

test('rejects an existing symbolic link in the runtime ancestor chain', async (t) => {
  const rootDirectory = await mkdtemp(join(tmpdir(), 'superagent-ancestor-'));
  const publicDir = join(rootDirectory, 'public');
  const externalDirectory = join(rootDirectory, 'external');
  const linkedParent = join(rootDirectory, 'linked-parent');
  await mkdir(publicDir);
  await mkdir(externalDirectory);
  await symlink(externalDirectory, linkedParent);
  t.after(() => rm(rootDirectory, { recursive: true, force: true }));

  assert.throws(
    () => createDemoServer({
      runtimeDir: join(linkedParent, 'runtime'),
      publicDir,
      fixtureDir: fixtureDirectory,
    }),
    (error) => {
      assert.equal(error.code, 'RUNTIME_INTEGRITY_ERROR');
      assert.equal(error.message.includes(rootDirectory), false);
      return true;
    },
  );
  assert.deepEqual(await readdir(externalDirectory), []);
});
