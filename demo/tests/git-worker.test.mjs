import assert from 'node:assert/strict';
import {
  chmod,
  cp,
  link,
  lstat,
  mkdir,
  readFile,
  readdir,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import {
  GitWorker,
  GitWorkerError,
  ASSIGNMENT_BRANCH,
} from '../src/git-worker.mjs';
import { ProcessError, runProcess } from '../src/process.mjs';
import {
  cleanupTemporaryDirectories,
  createInitializedWorker,
  createInjectedGitResultRunner,
  createInjectedGreenRunner,
  createInjectedRedRunner,
  createProcessResult,
  createRedOutput,
  createTemporaryDirectory,
  createTruncatingRunner,
  fixtureDirectory,
  gitWorkerModuleUrl,
  runGit,
} from './git-worker-test-helpers.mjs';

const { NODE_TEST_CONTEXT: ignoredTestContext, ...testEnvironment } = process.env;
const expectedInitialRegressionName =
  'returns zero for a 100 percent discount';

async function assertRedEvidenceRejected(redResult) {
  const { worker } = await createInitializedWorker(
    createInjectedRedRunner(redResult),
  );

  await assert.rejects(
    worker.runAssignment('initial'),
    /regression test did not provide strict red evidence/i,
  );
}

async function waitForFile(filePath, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await readFile(filePath, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
  }
  throw new Error('Timed out waiting for child process evidence');
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

async function waitForProcessExit(pid, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  assert.fail(`Process ${pid} survived its timeout`);
}

test.after(cleanupTemporaryDirectories);

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

test(
  'the process adapter kills a POSIX process tree and settles within a hard limit',
  { skip: process.platform === 'win32' },
  async () => {
    const workingDirectory = await createTemporaryDirectory();
    const pidFile = join(workingDirectory, 'grandchild.pid');
    const childSource = `
      import { spawn } from 'node:child_process';
      import { writeFileSync } from 'node:fs';
      const [pidFile, nodePath] = process.argv.slice(1);
      const grandchild = spawn(
        nodePath,
        ['-e', 'setInterval(() => {}, 1_000)'],
        { stdio: ['ignore', 'inherit', 'inherit'] },
      );
      writeFileSync(pidFile, String(grandchild.pid));
      setInterval(() => {}, 1_000);
    `;
    let grandchildPid;
    let hardLimitTimer;
    const startedAt = Date.now();

    try {
      const result = await Promise.race([
        runProcess(
          process.execPath,
          [
            '--input-type=module',
            '--eval',
            childSource,
            pidFile,
            process.execPath,
          ],
          { cwd: workingDirectory, timeoutMs: 50 },
        ),
        new Promise((_, rejectLimit) => {
          hardLimitTimer = setTimeout(
            () => rejectLimit(new Error('runProcess exceeded its hard limit')),
            1_000,
          );
        }),
      ]);
      grandchildPid = Number(await waitForFile(pidFile));

      assert.equal(result.timedOut, true);
      assert.equal(result.terminationScope, 'posix-process-group');
      assert.ok(Date.now() - startedAt < 700);
      await waitForProcessExit(grandchildPid);
    } finally {
      if (!grandchildPid) {
        try {
          grandchildPid = Number(await readFile(pidFile, 'utf8'));
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
      if (grandchildPid && isProcessAlive(grandchildPid)) {
        process.kill(grandchildPid, 'SIGKILL');
      }
      clearTimeout(hardLimitTimer);
    }
  },
);

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

  await assert.rejects(worker.initialize(), (error) => {
    assert.ok(error instanceof GitWorkerError);
    assert.match(error.message, /symbolic link/i);
    assert.equal(error.message.includes(fixtureCopy), false);
    assert.equal(error.message.includes(pathToFileURL(fixtureCopy).href), false);
    return true;
  });
  assert.equal(await readFile(externalFile, 'utf8'), externalContent);
  await assert.rejects(lstat(repositoryDirectory), { code: 'ENOENT' });
});

test('initialization rejects a symlinked repository parent before external writes', async () => {
  const rootDirectory = await createTemporaryDirectory();
  const externalDirectory = join(rootDirectory, 'outside');
  const linkedParent = join(rootDirectory, 'linked parent');
  const repositoryDirectory = join(linkedParent, 'runtime repository');
  await mkdir(externalDirectory);
  await writeFile(join(externalDirectory, 'sentinel.txt'), 'unchanged\n', 'utf8');
  await symlink(externalDirectory, linkedParent);
  const worker = new GitWorker({
    fixtureDir: fixtureDirectory,
    repoDir: repositoryDirectory,
  });

  await assert.rejects(worker.initialize(), /symbolic link/i);
  assert.deepEqual(await readdir(externalDirectory), ['sentinel.txt']);
});

test('initialization failure removes its partial repository and staging directory', async () => {
  const rootDirectory = await createTemporaryDirectory();
  const repositoryDirectory = join(rootDirectory, 'runtime repository');
  const failingProcessRunner = async (command, args, options) => {
    if (command === 'git') {
      throw new ProcessError('Git is unavailable', {
        stdout: '',
        stderr: 'git unavailable',
        code: 127,
        signal: null,
        timedOut: false,
        outputTruncated: false,
      });
    }
    return runProcess(command, args, options);
  };
  const worker = new GitWorker({
    fixtureDir: fixtureDirectory,
    repoDir: repositoryDirectory,
    processRunner: failingProcessRunner,
  });

  await assert.rejects(worker.initialize(), /git unavailable/i);
  await assert.rejects(lstat(repositoryDirectory), { code: 'ENOENT' });
  assert.equal(
    (await readdir(rootDirectory)).some((entry) => entry.includes('.staging-')),
    false,
  );
});

test('assignment containment rejection performs no Git writes and remains retryable', async () => {
  const rootDirectory = await createTemporaryDirectory();
  const repositoryDirectory = join(rootDirectory, 'runtime repository');
  const externalFile = join(rootDirectory, 'outside-discount.mjs');
  let observeAssignmentCommands = false;
  let assignmentGitArguments = [];
  const observingProcessRunner = async (command, args, options) => {
    if (observeAssignmentCommands && command === 'git') {
      assignmentGitArguments = [...assignmentGitArguments, args];
    }
    return runProcess(command, args, options);
  };
  const externalContent = await readFile(
    join(fixtureDirectory, 'src/discount.mjs'),
    'utf8',
  );
  const worker = new GitWorker({
    fixtureDir: fixtureDirectory,
    repoDir: repositoryDirectory,
    processRunner: observingProcessRunner,
  });
  await worker.initialize();
  await writeFile(externalFile, externalContent, 'utf8');
  await unlink(join(repositoryDirectory, 'src/discount.mjs'));
  await symlink(externalFile, join(repositoryDirectory, 'src/discount.mjs'));
  observeAssignmentCommands = true;

  await assert.rejects(worker.runAssignment('initial'), (error) => {
    assert.ok(error instanceof GitWorkerError);
    assert.match(error.message, /symbolic link/i);
    const publicError = JSON.stringify({
      name: error.name,
      message: error.message,
    });
    assert.equal(publicError.includes(repositoryDirectory), false);
    assert.equal(
      publicError.includes(pathToFileURL(repositoryDirectory).href),
      false,
    );
    return true;
  });
  assert.equal(await readFile(externalFile, 'utf8'), externalContent);
  assert.deepEqual(assignmentGitArguments, []);

  await unlink(join(repositoryDirectory, 'src/discount.mjs'));
  await writeFile(
    join(repositoryDirectory, 'src/discount.mjs'),
    externalContent,
    'utf8',
  );
  observeAssignmentCommands = false;
  const retried = await worker.runAssignment('initial');
  assert.equal(retried.branch, ASSIGNMENT_BRANCH);
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

test('initialization ignores global Git hooks from the caller home directory', async () => {
  const rootDirectory = await createTemporaryDirectory();
  const repositoryDirectory = join(rootDirectory, 'runtime repository');
  const hostileHome = join(rootDirectory, 'hostile home');
  const hooksDirectory = join(rootDirectory, 'outside hooks');
  const hookSentinel = join(rootDirectory, 'hook-ran.txt');
  await mkdir(hostileHome);
  await mkdir(hooksDirectory);
  await writeFile(
    join(hostileHome, '.gitconfig'),
    `[core]\n\thooksPath = ${hooksDirectory}\n`,
    'utf8',
  );
  await writeFile(
    join(hooksDirectory, 'pre-commit'),
    `#!/bin/sh\nprintf 'ran' > '${hookSentinel}'\n`,
    'utf8',
  );
  await chmod(join(hooksDirectory, 'pre-commit'), 0o755);

  const childSource = `
    import { GitWorker } from ${JSON.stringify(gitWorkerModuleUrl)};
    const [fixtureDir, repoDir] = process.argv.slice(1);
    await new GitWorker({ fixtureDir, repoDir }).initialize();
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
      env: { ...testEnvironment, HOME: hostileHome },
    },
  );

  assert.equal(result.code, 0, result.stderr);
  await assert.rejects(lstat(hookSentinel), { code: 'ENOENT' });
});

test('fixture tests receive only the minimal child process environment', async () => {
  const rootDirectory = await createTemporaryDirectory();
  const repositoryDirectory = join(rootDirectory, 'runtime repository');
  let observedTestEnvironments = [];
  const observingProcessRunner = async (command, args, options) => {
    if (command === process.execPath && args[0] === '--test') {
      observedTestEnvironments = [
        ...observedTestEnvironments,
        { ...options.env },
      ];
    }
    return runProcess(command, args, options);
  };
  const worker = new GitWorker({
    fixtureDir: fixtureDirectory,
    repoDir: repositoryDirectory,
    processRunner: observingProcessRunner,
  });

  await worker.initialize();
  await worker.runAssignment('initial');

  const allowedNames = new Set([
    'PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TMP', 'TEMP',
    'SystemRoot', 'WINDIR', 'PATHEXT', 'ComSpec',
  ]);
  assert.equal(observedTestEnvironments.length, 2);
  for (const environment of observedTestEnvironments) {
    const unexpectedNames = Object.keys(environment).filter(
      (name) => !allowedNames.has(name),
    );
    assert.deepEqual(unexpectedNames, []);
  }
});

test('post-initialization Git uses explicit verified repository paths', async () => {
  let observeGit = false;
  let gitEnvironments = [];
  const observingRunner = async (command, args, options) => {
    if (observeGit && command === 'git') {
      gitEnvironments = [...gitEnvironments, { ...options.env }];
    }
    return runProcess(command, args, options);
  };
  const { worker, repositoryDirectory } = await createInitializedWorker(
    observingRunner,
  );
  observeGit = true;
  await worker.runAssignment('initial');

  assert.ok(gitEnvironments.length > 0);
  for (const environment of gitEnvironments) {
    assert.equal(environment.GIT_DIR, join(repositoryDirectory, '.git'));
    assert.equal(environment.GIT_WORK_TREE, repositoryDirectory);
  }
});

const expectedFailureOutput = createRedOutput({
  failedNames: [expectedInitialRegressionName],
});
const malformedRedEvidence = [
  ['a test process terminated by a signal', {
    stdout: expectedFailureOutput, code: 1, signal: 'SIGTERM',
  }],
  ['a timed out test process', {
    stdout: expectedFailureOutput, code: 1, signal: 'SIGKILL', timedOut: true,
  }],
  ['truncated test output', {
    stdout: expectedFailureOutput, code: 1, outputTruncated: true,
  }],
  ['more than one failed test', {
    stdout: createRedOutput({
      failedNames: [expectedInitialRegressionName, 'unrelated failure'],
    }),
    code: 1,
  }],
  ['a different failed test', {
    stdout: createRedOutput({
      failedNames: ['unrelated failure'],
      passingNames: [expectedInitialRegressionName],
    }),
    code: 1,
  }],
];

for (const [description, overrides] of malformedRedEvidence) {
  test(`strict red evidence rejects ${description}`, async () => {
    await assertRedEvidenceRejected(createProcessResult(overrides));
  });
}

test('assignment failure rolls back Git state and permits a retry', async () => {
  const failedRedResult = createProcessResult({
    stdout: createRedOutput({ failedNames: [expectedInitialRegressionName] }),
    code: 2,
  });
  const { worker, repositoryDirectory, initialized } =
    await createInitializedWorker(
      createInjectedRedRunner(failedRedResult),
    );

  await assert.rejects(
    worker.runAssignment('initial'),
    /strict red evidence/i,
  );
  const [branchAfterFailure, headAfterFailure, statusAfterFailure] =
    await Promise.all([
      runGit(repositoryDirectory, ['branch', '--show-current']),
      runGit(repositoryDirectory, ['rev-parse', 'HEAD']),
      runGit(repositoryDirectory, ['status', '--short']),
    ]);

  assert.equal(branchAfterFailure.stdout.trim(), 'main');
  assert.equal(headAfterFailure.stdout.trim(), initialized.initialCommit);
  assert.equal(statusAfterFailure.stdout, '');

  const retried = await worker.runAssignment('initial');
  assert.equal(retried.branch, ASSIGNMENT_BRANCH);
  assert.equal(retried.commits.length, 1);
});

test('assignment rejects truncated green test evidence', async () => {
  let testRunCount = 0;
  const { worker } = await createInitializedWorker(
    createTruncatingRunner((command, args) => {
      if (command !== process.execPath || args[0] !== '--test') return false;
      testRunCount += 1;
      return testRunCount === 2;
    }),
  );

  await assert.rejects(worker.runAssignment('initial'), /truncated/i);
});

test('invalid green exit rolls back without commit and permits retry', async () => {
  const invalidGreen = createProcessResult({
    stdout: createRedOutput({ failedNames: ['green suite failure'] }),
    code: 9,
  });
  const { worker, repositoryDirectory, initialized } =
    await createInitializedWorker(createInjectedGreenRunner(invalidGreen));

  await assert.rejects(worker.runAssignment('initial'), /green test result/i);
  const [branch, head, status, commitCount] = await Promise.all([
    runGit(repositoryDirectory, ['branch', '--show-current']),
    runGit(repositoryDirectory, ['rev-parse', 'HEAD']),
    runGit(repositoryDirectory, ['status', '--short']),
    runGit(repositoryDirectory, ['rev-list', '--count', 'HEAD']),
  ]);
  assert.equal(branch.stdout.trim(), 'main');
  assert.equal(head.stdout.trim(), initialized.initialCommit);
  assert.equal(status.stdout, '');
  assert.equal(commitCount.stdout.trim(), '1');
  assert.equal((await worker.runAssignment('initial')).tests.ok, true);
});

for (const [description, overrides] of [
  ['signal', { code: 0, signal: 'SIGTERM' }],
  ['timeout', { code: 0, signal: 'SIGKILL', timedOut: true }],
]) {
  test(`green evidence rejects a ${description} result`, async () => {
    const greenResult = createProcessResult(overrides);
    const { worker } = await createInitializedWorker(
      createInjectedGreenRunner(greenResult),
    );
    await assert.rejects(worker.runAssignment('initial'), /green test result/i);
  });
}

for (const [description, overrides] of [
  ['non-zero exit', { code: 7 }],
  ['signal', { code: 0, signal: 'SIGTERM' }],
  ['timeout', { code: 0, signal: 'SIGKILL', timedOut: true }],
]) {
  test(`Git evidence rejects a ${description} result`, async () => {
    const { worker } = await createInitializedWorker(
      createInjectedGitResultRunner(overrides),
    );
    await assert.rejects(worker.runAssignment('initial'), /Git command result/i);
  });
}

test('assignment rejects truncated Git evidence', async () => {
  const { worker } = await createInitializedWorker(
    createTruncatingRunner(
      (command, args) => command === 'git' && args.includes('log'),
    ),
  );

  await assert.rejects(worker.runAssignment('initial'), /truncated/i);
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
