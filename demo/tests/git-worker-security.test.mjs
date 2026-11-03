import assert from 'node:assert/strict';
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { GitWorker, GitWorkerError } from '../src/git-worker.mjs';
import { ProcessError, runProcess } from '../src/process.mjs';
import {
  cleanupTemporaryDirectories,
  createInitializedWorker,
  createProcessResult,
  createTemporaryDirectory,
  fixtureDirectory,
  initializeRepository,
  runGit,
} from './git-worker-test-helpers.mjs';

function createProcessObserver() {
  let enabled = false;
  let calls = [];
  return Object.freeze({
    enable() {
      enabled = true;
    },
    disable() {
      enabled = false;
    },
    getCalls() {
      return calls;
    },
    async runner(command, args, options) {
      if (enabled) calls = [...calls, { command, args, options }];
      return runProcess(command, args, options);
    },
  });
}

async function assertMarkerMissing(markerPath) {
  await assert.rejects(lstat(markerPath), { code: 'ENOENT' });
}

test.after(cleanupTemporaryDirectories);

test('initialization failure hides raw and encoded staging paths', async () => {
  const rootDirectory = await createTemporaryDirectory();
  const repositoryDirectory = join(rootDirectory, 'runtime repository');
  let stagingDirectory;
  const failingProcessRunner = async (command, args, options) => {
    if (command !== 'git') return runProcess(command, args, options);
    stagingDirectory = options.cwd;
    const stagingUrl = pathToFileURL(stagingDirectory).href;
    throw new ProcessError(
      'Git initialization failed',
      createProcessResult({
        stderr: `staging paths: ${stagingDirectory} ${stagingUrl}`,
        code: 127,
      }),
    );
  };
  const worker = new GitWorker({
    fixtureDir: fixtureDirectory,
    repoDir: repositoryDirectory,
    processRunner: failingProcessRunner,
  });

  await assert.rejects(worker.initialize(), (error) => {
    const stagingUrl = pathToFileURL(stagingDirectory).href;
    assert.ok(error instanceof GitWorkerError);
    assert.equal(error.message.includes(stagingDirectory), false);
    assert.equal(error.message.includes(stagingUrl), false);
    assert.match(error.cause.result.stderr, new RegExp(stagingDirectory));
    assert.equal(error.cause.result.stderr.includes(stagingUrl), true);
    return true;
  });
});

test('Git metadata identity rejects a replaced .git before any Git process', async () => {
  const rootDirectory = await createTemporaryDirectory();
  const externalRepository = join(rootDirectory, 'outside repository');
  await initializeRepository(externalRepository, 'outside');
  const externalHead = await runGit(externalRepository, ['rev-parse', 'HEAD']);
  const externalBranch = await runGit(externalRepository, [
    'branch',
    '--show-current',
  ]);
  const observer = createProcessObserver();
  const { worker, repositoryDirectory } = await createInitializedWorker(
    observer.runner,
  );
  await rename(
    join(repositoryDirectory, '.git'),
    join(rootDirectory, 'original runtime git'),
  );
  await symlink(
    join(externalRepository, '.git'),
    join(repositoryDirectory, '.git'),
  );
  observer.enable();

  await assert.rejects(worker.runAssignment('initial'), /Git metadata identity/i);
  assert.deepEqual(observer.getCalls(), []);
  const [headAfterAttack, branchAfterAttack] = await Promise.all([
    runGit(externalRepository, ['rev-parse', 'HEAD']),
    runGit(externalRepository, ['branch', '--show-current']),
  ]);
  assert.equal(headAfterAttack.stdout, externalHead.stdout);
  assert.equal(branchAfterAttack.stdout, externalBranch.stdout);
});

for (const replacement of ['symbolic link', 'new directory']) {
  test(`Git metadata identity rejects a control ${replacement} before Git`, async () => {
    const observer = createProcessObserver();
    const { worker, repositoryDirectory } = await createInitializedWorker(
      observer.runner,
    );
    const controlDirectory = join(
      repositoryDirectory,
      '.git/superagent-control',
    );
    const displacedControl = join(
      repositoryDirectory,
      '.git/original-superagent-control',
    );
    await rename(controlDirectory, displacedControl);
    if (replacement === 'symbolic link') {
      const externalControl = join(repositoryDirectory, '../outside-control');
      await mkdir(externalControl);
      await symlink(externalControl, controlDirectory);
    } else {
      await mkdir(controlDirectory);
    }
    observer.enable();

    await assert.rejects(
      worker.runAssignment('initial'),
      /Git metadata identity/i,
    );
    assert.deepEqual(observer.getCalls(), []);
  });
}

test('initialization pins safe values in both controlled Git configs', async () => {
  const rootDirectory = await createTemporaryDirectory();
  const repositoryDirectory = join(rootDirectory, 'runtime repository');
  const worker = new GitWorker({
    fixtureDir: fixtureDirectory,
    repoDir: repositoryDirectory,
  });
  await worker.initialize();

  const configPaths = [
    join(repositoryDirectory, '.git/config'),
    join(repositoryDirectory, '.git/superagent-control/global.config'),
  ];
  for (const configPath of configPaths) {
    for (const [key, expected] of [
      ['commit.gpgsign', 'false'],
      ['tag.gpgsign', 'false'],
      ['core.fsmonitor', 'false'],
      ['core.hookspath', ''],
    ]) {
      const result = await runProcess(
        'git',
        ['config', '--file', configPath, '--get', key],
        { cwd: repositoryDirectory },
      );
      assert.equal(result.code, 0, `${configPath} is missing ${key}`);
      assert.equal(result.stdout.trim(), expected);
    }
  }
});

test('Git diff evidence always disables external diff drivers', async () => {
  const rootDirectory = await createTemporaryDirectory();
  const repositoryDirectory = join(rootDirectory, 'runtime repository');
  const observer = createProcessObserver();
  const worker = new GitWorker({
    fixtureDir: fixtureDirectory,
    repoDir: repositoryDirectory,
    processRunner: observer.runner,
  });
  await worker.initialize();
  observer.enable();
  await worker.runAssignment('initial');

  const diffCalls = observer.getCalls().filter(
    ({ command, args }) => command === 'git' && args.includes('diff'),
  );
  assert.ok(diffCalls.length > 0);
  for (const { args } of diffCalls) {
    const diffIndex = args.indexOf('diff');
    assert.equal(args[diffIndex + 1], '--no-ext-diff');
  }
});

for (const attack of [
  {
    name: 'an in-place global config overwrite',
    target: (repositoryDirectory) =>
      join(repositoryDirectory, '.git/superagent-control/global.config'),
    async apply({ targetPath, markerScript }) {
      const original = await readFile(targetPath, 'utf8');
      await writeFile(
        targetPath,
        `[core]\n\tfsmonitor = ${markerScript}\n`,
        'utf8',
      );
      return () => writeFile(targetPath, original, 'utf8');
    },
  },
  {
    name: 'an in-place local config overwrite',
    target: (repositoryDirectory) => join(repositoryDirectory, '.git/config'),
    async apply({ targetPath, markerScript }) {
      const original = await readFile(targetPath, 'utf8');
      await writeFile(
        targetPath,
        `${original}\n[core]\n\tfsmonitor = ${markerScript}\n`,
        'utf8',
      );
      return () => writeFile(targetPath, original, 'utf8');
    },
  },
  {
    name: 'an executable control hook',
    target: (repositoryDirectory) =>
      join(repositoryDirectory, '.git/superagent-control/hooks/pre-commit'),
    async apply({ targetPath, markerPath }) {
      await writeFile(
        targetPath,
        `#!/bin/sh\nprintf 'ran' > '${markerPath}'\n`,
        { encoding: 'utf8', mode: 0o700 },
      );
      await chmod(targetPath, 0o700);
      return () => unlink(targetPath);
    },
  },
]) {
  test(`Git safety rejects ${attack.name} before any process and permits retry`, async () => {
    const rootDirectory = await createTemporaryDirectory();
    const repositoryDirectory = join(rootDirectory, 'runtime repository');
    const markerPath = join(rootDirectory, 'external-marker.txt');
    const markerScript = join(rootDirectory, 'write-marker.sh');
    await writeFile(
      markerScript,
      `#!/bin/sh\nprintf 'ran' > '${markerPath}'\n`,
      { encoding: 'utf8', mode: 0o700 },
    );
    await chmod(markerScript, 0o700);
    const observer = createProcessObserver();
    const worker = new GitWorker({
      fixtureDir: fixtureDirectory,
      repoDir: repositoryDirectory,
      processRunner: observer.runner,
    });
    await worker.initialize();
    const targetPath = attack.target(repositoryDirectory);
    let inodeBeforeAttack;
    try {
      inodeBeforeAttack = (await lstat(targetPath)).ino;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const restore = await attack.apply({
      targetPath,
      markerPath,
      markerScript,
    });
    if (inodeBeforeAttack !== undefined) {
      assert.equal((await lstat(targetPath)).ino, inodeBeforeAttack);
    }
    observer.enable();

    await assert.rejects(worker.runAssignment('initial'), (error) => {
      assert.ok(error instanceof GitWorkerError);
      assert.match(error.message, /Git (?:metadata|control|safety)/i);
      assert.equal(error.message.includes(repositoryDirectory), false);
      assert.equal(
        error.message.includes(pathToFileURL(repositoryDirectory).href),
        false,
      );
      return true;
    });
    assert.deepEqual(observer.getCalls(), []);
    await assertMarkerMissing(markerPath);

    await restore();
    observer.disable();
    assert.equal((await worker.runAssignment('initial')).tests.ok, true);
    await assertMarkerMissing(markerPath);
  });
}
