import assert from 'node:assert/strict';
import {
  cp,
  link,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

import {
  GitWorker,
  GitWorkerError,
  ASSIGNMENT_BRANCH,
} from '../src/git-worker.mjs';
import { ProcessError, runProcess } from '../src/process.mjs';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const fixtureDirectory = resolve(testDirectory, '../fixture');
const gitWorkerModuleUrl = pathToFileURL(
  resolve(testDirectory, '../src/git-worker.mjs'),
).href;
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

test('initialization rejects fixture symlinks before copying the repository', async () => {
  const rootDirectory = await createTemporaryDirectory();
  const fixtureCopy = join(rootDirectory, 'fixture copy');
  const repositoryDirectory = join(rootDirectory, 'runtime repository');
  const externalFile = join(rootDirectory, 'outside-discount.mjs');
  const externalContent = 'export const outside = true;\n';
  await cp(fixtureDirectory, fixtureCopy, { recursive: true });
  await writeFile(externalFile, externalContent, 'utf8');
  await unlink(join(fixtureCopy, 'src/discount.mjs'));
  await symlink(externalFile, join(fixtureCopy, 'src/discount.mjs'));
  const worker = new GitWorker({
    fixtureDir: fixtureCopy,
    repoDir: repositoryDirectory,
  });

  await assert.rejects(worker.initialize(), /symbolic link/i);
  assert.equal(await readFile(externalFile, 'utf8'), externalContent);
  await assert.rejects(lstat(repositoryDirectory), { code: 'ENOENT' });
});

test('assignment rejects a runtime symlink without changing its external target', async () => {
  const rootDirectory = await createTemporaryDirectory();
  const repositoryDirectory = join(rootDirectory, 'runtime repository');
  const externalFile = join(rootDirectory, 'outside-discount.mjs');
  const externalContent = await readFile(
    join(fixtureDirectory, 'src/discount.mjs'),
    'utf8',
  );
  const worker = new GitWorker({
    fixtureDir: fixtureDirectory,
    repoDir: repositoryDirectory,
  });
  await worker.initialize();
  await writeFile(externalFile, externalContent, 'utf8');
  await unlink(join(repositoryDirectory, 'src/discount.mjs'));
  await symlink(externalFile, join(repositoryDirectory, 'src/discount.mjs'));

  await assert.rejects(worker.runAssignment('initial'), /symbolic link/i);
  assert.equal(await readFile(externalFile, 'utf8'), externalContent);
});

test('assignment rejects a runtime hard link without changing its external target', async () => {
  const rootDirectory = await createTemporaryDirectory();
  const repositoryDirectory = join(rootDirectory, 'runtime repository');
  const externalFile = join(rootDirectory, 'outside-discount.mjs');
  const externalContent = await readFile(
    join(fixtureDirectory, 'src/discount.mjs'),
    'utf8',
  );
  const worker = new GitWorker({
    fixtureDir: fixtureDirectory,
    repoDir: repositoryDirectory,
  });
  await worker.initialize();
  await writeFile(externalFile, externalContent, 'utf8');
  await unlink(join(repositoryDirectory, 'src/discount.mjs'));
  await link(externalFile, join(repositoryDirectory, 'src/discount.mjs'));
  assert.equal((await lstat(externalFile)).nlink, 2);

  await assert.rejects(worker.runAssignment('initial'), /hard link/i);
  assert.equal(await readFile(externalFile, 'utf8'), externalContent);
});

test('initialization ignores Git environment variables that redirect side effects', async () => {
  const rootDirectory = await createTemporaryDirectory();
  const repositoryDirectory = join(rootDirectory, 'runtime repository');
  const externalGitDirectory = join(rootDirectory, 'outside.git');
  const externalWorkTree = join(rootDirectory, 'outside worktree');
  const externalSentinel = join(externalWorkTree, 'sentinel.txt');
  await mkdir(externalWorkTree);
  await writeFile(externalSentinel, 'do not change\n', 'utf8');

  const childSource = `
    import { GitWorker } from ${JSON.stringify(gitWorkerModuleUrl)};
    const [fixtureDir, repoDir] = process.argv.slice(1);
    const worker = new GitWorker({ fixtureDir, repoDir });
    await worker.initialize();
  `;
  const result = await runProcess(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      childSource,
      fixtureDirectory,
      repositoryDirectory,
    ],
    {
      cwd: rootDirectory,
      env: {
        ...testEnvironment,
        GIT_DIR: externalGitDirectory,
        GIT_WORK_TREE: externalWorkTree,
      },
    },
  );

  assert.equal(result.code, 0, result.stderr);
  assert.equal((await lstat(join(repositoryDirectory, '.git'))).isDirectory(), true);
  await assert.rejects(lstat(externalGitDirectory), { code: 'ENOENT' });
  assert.equal(await readFile(externalSentinel, 'utf8'), 'do not change\n');
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
  const serializedFirstResult = JSON.stringify(first);
  assert.equal(serializedFirstResult.includes(repositoryDirectory), false);
  assert.equal(
    serializedFirstResult.includes(pathToFileURL(repositoryDirectory).href),
    false,
  );
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
  const serializedSecondResult = JSON.stringify(second);
  assert.equal(serializedSecondResult.includes(repositoryDirectory), false);
  assert.equal(
    serializedSecondResult.includes(pathToFileURL(repositoryDirectory).href),
    false,
  );
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
