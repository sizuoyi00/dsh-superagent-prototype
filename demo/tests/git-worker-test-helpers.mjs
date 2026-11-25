import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { GitWorker } from '../src/git-worker.mjs';
import { runProcess } from '../src/process.mjs';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const temporaryDirectories = [];

export const fixtureDirectory = resolve(testDirectory, '../fixture');
export const gitWorkerModuleUrl = pathToFileURL(
  resolve(testDirectory, '../src/git-worker.mjs'),
).href;

export function createProcessResult(overrides = {}) {
  return {
    stdout: '',
    stderr: '',
    code: 0,
    signal: null,
    timedOut: false,
    outputTruncated: false,
    terminationScope:
      process.platform === 'win32'
        ? 'direct-child-fallback'
        : 'posix-process-group',
    ...overrides,
  };
}

export function createRedOutput({ failedNames, passingNames = [] }) {
  const testLines = [...passingNames, ...failedNames].flatMap((name, index) => {
    const passed = index < passingNames.length;
    return [
      `# Subtest: ${name}`,
      `${passed ? 'ok' : 'not ok'} ${index + 1} - ${name}`,
    ];
  });
  const total = passingNames.length + failedNames.length;
  return [
    'TAP version 13',
    ...testLines,
    `1..${total}`,
    `# tests ${total}`,
    `# pass ${passingNames.length}`,
    `# fail ${failedNames.length}`,
    '',
  ].join('\n');
}

function createInjectedTestRunner(injectedResult, injectedRun) {
  let testRunCount = 0;
  return async (command, args, options) => {
    if (command === process.execPath && args[0] === '--test') {
      testRunCount += 1;
      if (testRunCount === injectedRun) return injectedResult;
    }
    return runProcess(command, args, options);
  };
}

export function createInjectedRedRunner(redResult) {
  return createInjectedTestRunner(redResult, 1);
}

export function createInjectedGreenRunner(greenResult) {
  return createInjectedTestRunner(greenResult, 2);
}

export function createInjectedGitResultRunner(overrides) {
  let injected = false;
  return async (command, args, options) => {
    const result = await runProcess(command, args, options);
    if (!injected && command === 'git' && args.includes('log')) {
      injected = true;
      return { ...result, ...overrides };
    }
    return result;
  };
}

export function createTruncatingRunner(shouldTruncate) {
  return async (command, args, options) => {
    const result = await runProcess(command, args, options);
    return shouldTruncate(command, args)
      ? { ...result, outputTruncated: true }
      : result;
  };
}

export async function createTemporaryDirectory(
  prefix = 'superagent-git-worker-',
) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

export async function cleanupTemporaryDirectories() {
  await Promise.all(
    temporaryDirectories.map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
}

export async function runGit(repositoryDirectory, args) {
  return runProcess('git', args, {
    cwd: repositoryDirectory,
    rejectOnNonZero: true,
  });
}

export async function initializeRepository(repositoryDirectory, branch) {
  await mkdir(repositoryDirectory);
  await runGit(repositoryDirectory, ['init', `--initial-branch=${branch}`]);
  await runGit(repositoryDirectory, ['config', 'user.name', 'Outside Repo']);
  await runGit(repositoryDirectory, [
    'config',
    'user.email',
    'outside@example.invalid',
  ]);
  await writeFile(join(repositoryDirectory, 'sentinel.txt'), 'outside\n');
  await runGit(repositoryDirectory, ['add', 'sentinel.txt']);
  await runGit(repositoryDirectory, ['commit', '-m', 'outside baseline']);
}

export async function createInitializedWorker(processRunner) {
  const rootDirectory = await createTemporaryDirectory();
  const repositoryDirectory = join(rootDirectory, 'runtime repository');
  const worker = new GitWorker({
    fixtureDir: fixtureDirectory,
    repoDir: repositoryDirectory,
    processRunner,
  });
  const initialized = await worker.initialize();
  return { worker, repositoryDirectory, initialized };
}
