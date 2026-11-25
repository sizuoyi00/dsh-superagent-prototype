import assert from 'node:assert/strict';
import {
  chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { startAssignment } from '../src/domain.mjs';
import { ASSIGNMENT_BRANCH, GitWorker } from '../src/git-worker.mjs';
import { runProcess } from '../src/process.mjs';
import { createDemoServer } from '../src/server.mjs';
import {
  cleanupTemporaryDirectories,
  createInitializedWorker,
  fixtureDirectory,
  runGit,
} from './git-worker-test-helpers.mjs';

test.after(cleanupTemporaryDirectories);

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
}

async function postJson(baseUrl, pathname, body = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { response, value: JSON.parse(await response.text()) };
}

function assertResetRequired(result) {
  assert.equal(result.response.status, 409);
  assert.equal(result.value.code, 'WORKER_NOT_READY');
  assert.match(result.value.error, /reset/i);
}

async function createServerHarness(t) {
  const rootDirectory = await mkdtemp(join(tmpdir(), 'superagent-resume-'));
  const runtimeDir = join(rootDirectory, 'runtime');
  const publicDir = join(rootDirectory, 'public');
  await mkdir(publicDir);
  const servers = [];
  t.after(async () => {
    await Promise.all(servers.map(closeServer));
    await rm(rootDirectory, { recursive: true, force: true });
  });
  async function start() {
    const server = createDemoServer({
      runtimeDir,
      publicDir,
      fixtureDir: fixtureDirectory,
      doctor: async () => ({ ready: true, checks: [], blockers: [] }),
    });
    await new Promise((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(0, '127.0.0.1', resolveListen);
    });
    servers.push(server);
    return {
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      server,
    };
  }
  return { publicDir, rootDirectory, runtimeDir, start };
}

test('an initial failure retries the initial worker phase when no commit persisted', async (t) => {
  const harness = await createServerHarness(t);
  const running = await harness.start();
  await postJson(running.baseUrl, '/api/reset');
  await postJson(running.baseUrl, '/api/issue', {
    title: 'Retry the initial assignment',
    requester: 'retry-test',
    text: 'The first attempt is interrupted before its commit.',
  });
  const targetPath = join(harness.runtimeDir, 'repo/src/discount.mjs');
  const backupPath = join(harness.rootDirectory, 'discount.backup.mjs');
  await rename(targetPath, backupPath);
  await symlink(backupPath, targetPath);

  const failed = await postJson(running.baseUrl, '/api/run');
  await unlink(targetPath);
  await rename(backupPath, targetPath);
  const queued = await postJson(running.baseUrl, '/api/follow-up', {
    requester: 'retry-test',
    text: 'Retry the original work safely.',
  });
  const retried = await postJson(running.baseUrl, '/api/run');

  assert.equal(failed.response.status, 500);
  assert.equal(queued.response.status, 200);
  assert.equal(retried.response.status, 200);
  assert.equal(retried.value.phase, 'awaiting_review');
  assert.equal(retried.value.tickets[0].commits.length, 1);
  assert.equal(retried.value.assignments.at(-1).status, 'completed');
});

test('reset persists the trusted initial commit through domain transitions', async (t) => {
  const harness = await createServerHarness(t);
  const running = await harness.start();
  const reset = await postJson(running.baseUrl, '/api/reset');
  const root = await runGit(harness.runtimeDir, [
    '-C', 'repo', 'rev-list', '--max-parents=0', 'HEAD',
  ]);
  const issued = await postJson(running.baseUrl, '/api/issue', {
    title: 'Preserve the repository root',
    requester: 'anchor-test',
    text: 'Keep the trusted root in durable state.',
  });
  const persisted = JSON.parse(
    await readFile(join(harness.runtimeDir, 'state.json'), 'utf8'),
  );

  assert.equal(reset.value.repository.initialCommit, root.stdout.trim());
  assert.equal(issued.value.repository.initialCommit, root.stdout.trim());
  assert.equal(persisted.repository.initialCommit, root.stdout.trim());
});

test('resume with zero commits discards unpersisted work and restores initial readiness', async () => {
  const { worker, repositoryDirectory, initialized } = await createInitializedWorker();
  await worker.runAssignment('initial');
  const resumedWorker = new GitWorker({
    fixtureDir: fixtureDirectory,
    repoDir: repositoryDirectory,
  });

  const resumed = await resumedWorker.resume({
    commits: [],
    trustedInitialCommit: initialized.initialCommit,
  });
  const [head, branch, status, assignmentBranch] = await Promise.all([
    runGit(repositoryDirectory, ['rev-parse', 'HEAD']),
    runGit(repositoryDirectory, ['branch', '--show-current']),
    runGit(repositoryDirectory, ['status', '--short']),
    runGit(repositoryDirectory, ['branch', '--list', ASSIGNMENT_BRANCH]),
  ]);

  assert.equal(resumed.stage, 'ready');
  assert.equal(head.stdout.trim(), initialized.initialCommit);
  assert.equal(branch.stdout.trim(), 'main');
  assert.equal(status.stdout, '');
  assert.equal(assignmentBranch.stdout, '');
  assert.equal((await resumedWorker.runAssignment('initial')).commits.length, 1);
});

test('resume with one commit rolls back an unpersisted follow-up and permits retry', async () => {
  const { worker, repositoryDirectory, initialized } = await createInitializedWorker();
  const first = await worker.runAssignment('initial');
  await worker.runAssignment('follow-up');
  const resumedWorker = new GitWorker({
    fixtureDir: fixtureDirectory,
    repoDir: repositoryDirectory,
  });

  const resumed = await resumedWorker.resume({
    commits: first.commits,
    trustedInitialCommit: initialized.initialCommit,
  });
  const [head, branch, status] = await Promise.all([
    runGit(repositoryDirectory, ['rev-parse', 'HEAD']),
    runGit(repositoryDirectory, ['branch', '--show-current']),
    runGit(repositoryDirectory, ['status', '--short']),
  ]);

  assert.equal(resumed.stage, 'initial-complete');
  assert.equal(head.stdout.trim(), first.commits[0].hash);
  assert.equal(branch.stdout.trim(), ASSIGNMENT_BRANCH);
  assert.equal(status.stdout, '');
  assert.equal((await resumedWorker.runAssignment('follow-up')).commits.length, 2);
});

test('resume with two commits restores the completed milestone', async () => {
  const { worker, repositoryDirectory, initialized } = await createInitializedWorker();
  await worker.runAssignment('initial');
  const completed = await worker.runAssignment('follow-up');
  const resumedWorker = new GitWorker({
    fixtureDir: fixtureDirectory,
    repoDir: repositoryDirectory,
  });

  const resumed = await resumedWorker.resume({
    commits: completed.commits,
    trustedInitialCommit: initialized.initialCommit,
  });

  assert.equal(resumed.stage, 'complete');
  await assert.rejects(resumedWorker.runAssignment('initial'), /worker is complete/i);
  await assert.rejects(resumedWorker.runAssignment('follow-up'), /worker is complete/i);
});

test('resume validates persisted commit hashes and history before restoration', async () => {
  const { repositoryDirectory, initialized } = await createInitializedWorker();
  const resumedWorker = new GitWorker({
    fixtureDir: fixtureDirectory,
    repoDir: repositoryDirectory,
  });
  await assert.rejects(
    resumedWorker.resume({
      commits: [{ hash: 'not-a-commit' }],
      trustedInitialCommit: initialized.initialCommit,
    }),
    /commit hash/i,
  );
  await assert.rejects(
    resumedWorker.resume({
      commits: [
        { hash: 'a'.repeat(40) },
        { hash: 'b'.repeat(40) },
        { hash: 'c'.repeat(40) },
      ],
      trustedInitialCommit: initialized.initialCommit,
    }),
    /at most two/i,
  );
  await assert.rejects(
    resumedWorker.resume({
      commits: [
        { hash: initialized.initialCommit },
        { hash: initialized.initialCommit },
      ],
      trustedInitialCommit: initialized.initialCommit,
    }),
    /distinct/i,
  );
  assert.equal((await resumedWorker.resume({
    commits: [],
    trustedInitialCommit: initialized.initialCommit,
  })).stage, 'ready');
});

function createProcessObserver() {
  const calls = [];
  return {
    calls,
    async runner(command, args, options) {
      calls.push({ command, args, options });
      return runProcess(command, args, options);
    },
  };
}

for (const persistedCommitCount of [0, 1]) {
  test(`resume rejects a mismatched root anchor before Git with ${persistedCommitCount} persisted commit`, async () => {
    const { worker, repositoryDirectory, initialized } = await createInitializedWorker();
    const commits = persistedCommitCount === 0
      ? []
      : (await worker.runAssignment('initial')).commits;
    const tree = await runGit(repositoryDirectory, [
      'rev-parse', `${initialized.initialCommit}^{tree}`,
    ]);
    const replacementRoot = await runGit(repositoryDirectory, [
      'commit-tree', tree.stdout.trim(), '-m', 'tampered root',
    ]);
    await runGit(repositoryDirectory, [
      'update-ref', 'refs/heads/main', replacementRoot.stdout.trim(),
    ]);
    const observer = createProcessObserver();
    const resumedWorker = new GitWorker({
      fixtureDir: fixtureDirectory,
      repoDir: repositoryDirectory,
      processRunner: observer.runner,
    });
    await assert.rejects(
      resumedWorker.resume({
        commits,
        trustedInitialCommit: initialized.initialCommit,
      }),
      /initial commit|root|resume/i,
    );
    assert.deepEqual(observer.calls, []);
  });
}

test('resume requires a 40 or 64 hexadecimal trusted initial commit', async () => {
  const { repositoryDirectory } = await createInitializedWorker();
  const observer = createProcessObserver();
  const resumedWorker = new GitWorker({
    fixtureDir: fixtureDirectory,
    repoDir: repositoryDirectory,
    processRunner: observer.runner,
  });

  for (const trustedInitialCommit of [undefined, 'abc', 'g'.repeat(40)]) {
    await assert.rejects(
      resumedWorker.resume({ commits: [], trustedInitialCommit }),
      /trusted initial commit/i,
    );
  }
  await assert.rejects(
    resumedWorker.resume({
      commits: [{ hash: 'b'.repeat(40) }],
      trustedInitialCommit: 'a'.repeat(64),
    }),
    /object format/i,
  );
  await assert.rejects(
    resumedWorker.resume({ commits: [], trustedInitialCommit: 'a'.repeat(64) }),
    /initial commit|root/i,
  );
  assert.deepEqual(observer.calls, []);
});

for (const unsafeControl of ['global config', 'hook']) {
  test(`resume rejects an unsafe ${unsafeControl} before any Git process`, async () => {
    const { repositoryDirectory, initialized } = await createInitializedWorker();
    const controlDirectory = join(repositoryDirectory, '.git/superagent-control');
    if (unsafeControl === 'global config') {
      await writeFile(join(controlDirectory, 'global.config'), '[core]\n\thooksPath =\n');
    } else {
      await writeFile(join(controlDirectory, 'hooks/pre-commit'), '#!/bin/sh\n');
    }
    const observer = createProcessObserver();
    const resumedWorker = new GitWorker({
      fixtureDir: fixtureDirectory,
      repoDir: repositoryDirectory,
      processRunner: observer.runner,
    });

    await assert.rejects(resumedWorker.resume({
      commits: [],
      trustedInitialCommit: initialized.initialCommit,
    }), /Git safety|resume/i);
    assert.deepEqual(observer.calls, []);
  });
}

test('resume replaces hostile local Git config before the first Git process', async () => {
  const { repositoryDirectory, initialized } = await createInitializedWorker();
  const configPath = join(repositoryDirectory, '.git/config');
  const markerPath = join(repositoryDirectory, '../local-config-ran.txt');
  const markerScript = join(repositoryDirectory, '../write-marker.sh');
  await writeFile(markerScript, `#!/bin/sh\nprintf ran > '${markerPath}'\n`, { mode: 0o700 });
  await chmod(markerScript, 0o700);
  await writeFile(
    configPath,
    `${await readFile(configPath, 'utf8')}\n[core]\n\tfsmonitor = ${markerScript}\n`,
  );
  const observer = createProcessObserver();
  const resumedWorker = new GitWorker({
    fixtureDir: fixtureDirectory,
    repoDir: repositoryDirectory,
    processRunner: observer.runner,
  });

  await resumedWorker.resume({
    commits: [],
    trustedInitialCommit: initialized.initialCommit,
  });

  assert.ok(observer.calls.length > 0);
  assert.equal((await readFile(configPath, 'utf8')).includes(markerScript), false);
  await assert.rejects(lstat(markerPath), { code: 'ENOENT' });
});

test('restart recovers an interrupted initial assignment and runs it', async (t) => {
  const harness = await createServerHarness(t);
  const original = await harness.start();
  await postJson(original.baseUrl, '/api/reset');
  const issued = await postJson(original.baseUrl, '/api/issue', {
    title: 'Resume the initial assignment',
    requester: 'restart-test',
    text: 'Continue after a server restart.',
  });
  const interrupted = startAssignment(issued.value);
  await closeServer(original.server);
  await writeFile(join(harness.runtimeDir, 'state.json'), JSON.stringify(interrupted));
  const restarted = await harness.start();

  const recovered = await postJson(restarted.baseUrl, '/api/recover');
  const completed = await postJson(restarted.baseUrl, '/api/run');

  assert.equal(recovered.response.status, 200);
  assert.equal(recovered.value.phase, 'queued');
  assert.equal(completed.response.status, 200);
  assert.equal(completed.value.tickets[0].commits.length, 1);
});

test('restart recovers an interrupted follow-up and runs the second commit', async (t) => {
  const harness = await createServerHarness(t);
  const original = await harness.start();
  await postJson(original.baseUrl, '/api/reset');
  await postJson(original.baseUrl, '/api/issue', {
    title: 'Resume the follow-up assignment',
    requester: 'restart-test',
    text: 'Persist the initial milestone.',
  });
  const first = await postJson(original.baseUrl, '/api/run');
  const queued = await postJson(original.baseUrl, '/api/follow-up', {
    requester: 'restart-test',
    text: 'Continue the second milestone after restart.',
  });
  const interrupted = startAssignment(queued.value);
  await closeServer(original.server);
  await writeFile(join(harness.runtimeDir, 'state.json'), JSON.stringify(interrupted));
  const restarted = await harness.start();

  const recovered = await postJson(restarted.baseUrl, '/api/recover');
  const completed = await postJson(restarted.baseUrl, '/api/run');

  assert.equal(first.value.tickets[0].commits.length, 1);
  assert.equal(recovered.response.status, 200);
  assert.equal(recovered.value.phase, 'queued');
  assert.equal(completed.response.status, 200);
  assert.equal(completed.value.tickets[0].commits.length, 2);
});

test('restart rejects an amended root before Git or fixture tests can run', async (t) => {
  const harness = await createServerHarness(t);
  const original = await harness.start();
  await postJson(original.baseUrl, '/api/reset');
  await postJson(original.baseUrl, '/api/issue', {
    title: 'Reject an amended root',
    requester: 'anchor-test',
    text: 'Do not execute repository content from an untrusted root.',
  });
  await closeServer(original.server);

  const repositoryDirectory = join(harness.runtimeDir, 'repo');
  const markerPath = join(harness.rootDirectory, 'fixture-test-ran.txt');
  await writeFile(
    join(repositoryDirectory, 'test/recovery-marker.test.mjs'),
    `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(markerPath)}, 'ran');\n`,
  );
  await runGit(repositoryDirectory, ['add', '--all']);
  await runGit(repositoryDirectory, ['commit', '--amend', '--no-edit']);

  const restarted = await harness.start();
  const recovered = await postJson(restarted.baseUrl, '/api/recover');
  const run = await postJson(restarted.baseUrl, '/api/run');

  assertResetRequired(recovered);
  assertResetRequired(run);
  await assert.rejects(lstat(markerPath), { code: 'ENOENT' });
});

test('restart requires reset when durable state has no trusted initial commit', async (t) => {
  const harness = await createServerHarness(t);
  const original = await harness.start();
  await postJson(original.baseUrl, '/api/reset');
  await postJson(original.baseUrl, '/api/issue', {
    title: 'Reject legacy recovery state',
    requester: 'anchor-test',
    text: 'Do not infer a root when the durable anchor is absent.',
  });
  await closeServer(original.server);

  const statePath = join(harness.runtimeDir, 'state.json');
  const persisted = JSON.parse(await readFile(statePath, 'utf8'));
  const { repository: omittedRepository, ...withoutRepository } = persisted;
  assert.ok(omittedRepository);
  await writeFile(statePath, JSON.stringify(withoutRepository));

  const restarted = await harness.start();
  const recovered = await postJson(restarted.baseUrl, '/api/recover');
  const run = await postJson(restarted.baseUrl, '/api/run');

  assertResetRequired(recovered);
  assertResetRequired(run);
});
