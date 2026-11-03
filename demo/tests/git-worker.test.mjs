import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  GitWorker,
  GitWorkerError,
  ASSIGNMENT_BRANCH,
} from '../src/git-worker.mjs';
import { ProcessError, runProcess } from '../src/process.mjs';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const fixtureDirectory = resolve(testDirectory, '../fixture');
const temporaryDirectories = [];
const { NODE_TEST_CONTEXT: ignoredTestContext, ...testEnvironment } = process.env;

async function createTemporaryDirectory(prefix = 'superagent-git-worker-') {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function runGit(repositoryDirectory, args) {
  return runProcess('git', args, {
    cwd: repositoryDirectory,
    rejectOnNonZero: true,
  });
}

test.after(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

test('the dependency-free fixture has a green baseline without the 100 percent regression', async () => {
  const result = await runProcess(process.execPath, ['--test'], {
    cwd: fixtureDirectory,
    rejectOnNonZero: true,
    env: testEnvironment,
  });
  const testSource = await readFile(
    join(fixtureDirectory, 'test/discount.test.mjs'),
    'utf8',
  );

  assert.equal(result.code, 0);
  assert.match(result.stdout, /pass 4/);
  assert.doesNotMatch(testSource, /100 percent discount/);
});

test('the process adapter preserves argument and cwd boundaries when paths contain spaces', async () => {
  const rootDirectory = await createTemporaryDirectory();
  const workingDirectory = join(rootDirectory, 'repository with spaces');
  await mkdir(workingDirectory);

  const result = await runProcess(
    process.execPath,
    ['-e', 'process.stdout.write(process.cwd())'],
    { cwd: workingDirectory },
  );

  assert.equal(result.code, 0);
  assert.equal(result.stdout, workingDirectory);
  assert.equal(result.stderr, '');
});

test('the process adapter bounds output and can reject non-zero exits clearly', async () => {
  const workingDirectory = await createTemporaryDirectory();
  const boundedResult = await runProcess(
    process.execPath,
    ['-e', "process.stdout.write('x'.repeat(256))"],
    { cwd: workingDirectory, maxOutputBytes: 32 },
  );

  assert.equal(Buffer.byteLength(boundedResult.stdout), 32);
  assert.equal(boundedResult.outputTruncated, true);

  await assert.rejects(
    runProcess(process.execPath, ['-e', 'process.exit(7)'], {
      cwd: workingDirectory,
      rejectOnNonZero: true,
    }),
    (error) => {
      assert.ok(error instanceof ProcessError);
      assert.equal(error.result.code, 7);
      assert.match(error.message, /code 7/);
      return true;
    },
  );
});

test('the process adapter applies its configured timeout', async () => {
  const workingDirectory = await createTemporaryDirectory();
  const result = await runProcess(
    process.execPath,
    ['-e', 'setTimeout(() => {}, 1_000)'],
    { cwd: workingDirectory, timeoutMs: 50 },
  );

  assert.equal(result.timedOut, true);
  assert.notEqual(result.signal, null);
});

test('initialization creates an isolated repository and safely rejects repetition', async () => {
  const rootDirectory = await createTemporaryDirectory();
  const repositoryDirectory = join(rootDirectory, 'runtime repository');
  const worker = new GitWorker({
    fixtureDir: fixtureDirectory,
    repoDir: repositoryDirectory,
  });

  const initialized = await worker.initialize();
  const branch = await runGit(repositoryDirectory, ['branch', '--show-current']);
  const commitCount = await runGit(repositoryDirectory, [
    'rev-list',
    '--count',
    'HEAD',
  ]);
  const authorName = await runGit(repositoryDirectory, [
    'config',
    '--local',
    'user.name',
  ]);

  assert.equal(initialized.branch, 'main');
  assert.match(initialized.initialCommit, /^[0-9a-f]{40,64}$/);
  assert.equal(branch.stdout.trim(), 'main');
  assert.equal(commitCount.stdout.trim(), '1');
  assert.equal(authorName.stdout.trim(), 'SuperAgent Demo');
  await assert.rejects(worker.initialize(), GitWorkerError);
});

test('assignments demonstrate two real red-green cycles on one clean branch', async () => {
  const rootDirectory = await createTemporaryDirectory();
  const repositoryDirectory = join(rootDirectory, 'runtime repository with spaces');
  const worker = new GitWorker({
    fixtureDir: fixtureDirectory,
    repoDir: repositoryDirectory,
  });

  await worker.initialize();
  const first = await worker.runAssignment('initial');
  const firstHead = await runGit(repositoryDirectory, ['rev-parse', 'HEAD']);
  const firstStatus = await runGit(repositoryDirectory, [
    'status',
    '--short',
  ]);

  assert.equal(first.branch, ASSIGNMENT_BRANCH);
  assert.equal(first.commits.length, 1);
  assert.equal(first.commits[0].message, 'fix: support 100 percent discounts');
  assert.equal(first.commits[0].hash, firstHead.stdout.trim());
  assert.equal(first.tests.ok, true);
  assert.equal(first.tests.command, 'node --test');
  assert.match(first.tests.output, /fail 0/);
  assert.match(first.tests.redEvidence, /returns zero for a 100 percent discount/);
  assert.match(first.tests.redEvidence, /exit code: 1/);
  assert.deepEqual(first.files, [
    'src/discount.mjs',
    'test/discount.test.mjs',
  ]);
  assert.match(first.patch, /discountPercent > 100/);
  assert.doesNotMatch(first.patch, new RegExp(repositoryDirectory));
  assert.equal(firstStatus.stdout, '');

  const second = await worker.runAssignment('follow-up');
  const secondBranch = await runGit(repositoryDirectory, [
    'branch',
    '--show-current',
  ]);
  const secondStatus = await runGit(repositoryDirectory, [
    'status',
    '--short',
  ]);
  const finalSuite = await runProcess(process.execPath, ['--test'], {
    cwd: repositoryDirectory,
    rejectOnNonZero: true,
    env: testEnvironment,
  });

  assert.equal(second.branch, ASSIGNMENT_BRANCH);
  assert.equal(secondBranch.stdout.trim(), ASSIGNMENT_BRANCH);
  assert.equal(second.commits.length, 2);
  assert.deepEqual(
    second.commits.map(({ message }) => message),
    [
      'fix: support 100 percent discounts',
      'fix: reject non-finite discount inputs',
    ],
  );
  assert.equal(second.tests.ok, true);
  assert.match(second.tests.output, /fail 0/);
  assert.match(second.tests.redEvidence, /rejects non-finite inputs/);
  assert.match(second.tests.redEvidence, /exit code: 1/);
  assert.deepEqual(second.files, [
    'README.md',
    'src/discount.mjs',
    'test/discount.test.mjs',
  ]);
  assert.match(second.patch, /Number\.isFinite/);
  assert.match(second.patch, /NaN and positive or negative Infinity/);
  assert.doesNotMatch(second.patch, new RegExp(repositoryDirectory));
  assert.equal(secondStatus.stdout, '');
  assert.equal(finalSuite.code, 0);

  const headBeforeInvalidCall = second.commits.at(-1).hash;
  await assert.rejects(
    worker.runAssignment('follow-up'),
    /cannot run follow-up assignment/i,
  );
  await assert.rejects(worker.runAssignment('unknown'), /invalid assignment phase/i);
  const headAfterInvalidCall = await runGit(repositoryDirectory, [
    'rev-parse',
    'HEAD',
  ]);
  assert.equal(headAfterInvalidCall.stdout.trim(), headBeforeInvalidCall);
});

test('assignments reject invalid ordering before writing into the runtime repository', async () => {
  const rootDirectory = await createTemporaryDirectory();
  const repositoryDirectory = join(rootDirectory, 'not initialized');
  const worker = new GitWorker({
    fixtureDir: fixtureDirectory,
    repoDir: repositoryDirectory,
  });

  await assert.rejects(
    worker.runAssignment('initial'),
    /must be initialized/i,
  );
  await assert.rejects(
    worker.runAssignment('follow-up'),
    /must be initialized/i,
  );
});
