import { randomUUID } from 'node:crypto';
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  unlink,
} from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  parse,
  relative,
  resolve,
  sep,
} from 'node:path';
import { pathToFileURL } from 'node:url';

import { ProcessError, runProcess } from './process.mjs';

export const ASSIGNMENT_BRANCH = 'agent/demo-discount-boundary';

const INITIAL_COMMIT_MESSAGE = 'chore: initialize discount fixture';
const FIRST_COMMIT_MESSAGE = 'fix: support 100 percent discounts';
const FOLLOW_UP_COMMIT_MESSAGE = 'fix: reject non-finite discount inputs';
const TEST_FILE = 'test/discount.test.mjs';
const IMPLEMENTATION_FILE = 'src/discount.mjs';
const README_FILE = 'README.md';
const TEST_COMMAND = 'node --test';
const CHILD_ENVIRONMENT_NAMES = [
  'PATH',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TMPDIR',
  'TMP',
  'TEMP',
  'SystemRoot',
  'WINDIR',
  'PATHEXT',
  'ComSpec',
];
const TEST_ENVIRONMENT = Object.fromEntries(
  CHILD_ENVIRONMENT_NAMES.flatMap((name) =>
    process.env[name] === undefined ? [] : [[name, process.env[name]]],
  ),
);

const FIRST_REGRESSION_TEST = `test('returns zero for a 100 percent discount', () => {
  assert.equal(applyDiscount(80, 100), 0);
});`;

const FOLLOW_UP_REGRESSION_TEST = `test('rejects non-finite inputs', () => {
  for (const amount of [NaN, Infinity, -Infinity]) {
    assert.throws(() => applyDiscount(amount, 10), /finite amount/i);
  }

  for (const discountPercent of [NaN, Infinity, -Infinity]) {
    assert.throws(
      () => applyDiscount(10, discountPercent),
      /finite discountPercent/i,
    );
  }
});`;

const FOLLOW_UP_DOCUMENTATION = `

Both arguments must be finite numbers. NaN and positive or negative Infinity
are rejected before the discount is calculated.`;

export class GitWorkerError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'GitWorkerError';
  }
}

function isWithin(parentDirectory, candidatePath) {
  const pathFromParent = relative(parentDirectory, candidatePath);
  return (
    pathFromParent === '' ||
    (!pathFromParent.startsWith('..') && !isAbsolute(pathFromParent))
  );
}

function appendSection(source, section) {
  return `${source.trimEnd()}\n\n${section}\n`;
}

function replaceOnce(source, original, replacement, fileName) {
  const firstIndex = source.indexOf(original);
  if (firstIndex === -1 || source.indexOf(original, firstIndex + 1) !== -1) {
    throw new GitWorkerError(`Expected one editable boundary in ${fileName}`);
  }
  return `${source.slice(0, firstIndex)}${replacement}${source.slice(
    firstIndex + original.length,
  )}`;
}

function combineOutput(result) {
  return [result.stdout.trimEnd(), result.stderr.trimEnd()]
    .filter(Boolean)
    .join('\n');
}

function assertSuccessfulResult(result, label) {
  const failures = [
    result.code === 0 ? undefined : `exit code ${String(result.code)}`,
    result.signal === null ? undefined : `signal ${String(result.signal)}`,
    result.timedOut === false ? undefined : 'timed out',
    result.outputTruncated === false ? undefined : 'output was truncated',
  ].filter(Boolean);
  if (failures.length > 0) {
    throw new GitWorkerError(`${label} result is invalid: ${failures.join(', ')}`);
  }
}

function sanitizeResult(value, privatePath, replacement = '<repo>') {
  if (typeof value === 'string') {
    return value
      .split(pathToFileURL(privatePath).href)
      .join(replacement)
      .split(privatePath)
      .join(replacement);
  }
  if (Array.isArray(value)) {
    return value.map((item) =>
      sanitizeResult(item, privatePath, replacement),
    );
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        sanitizeResult(item, privatePath, replacement),
      ]),
    );
  }
  return value;
}

async function assertTreeHasNoSymbolicLinks(treePath) {
  const metadata = await lstat(treePath);
  if (metadata.isSymbolicLink()) {
    throw new GitWorkerError(`Symbolic link is not allowed: ${treePath}`);
  }
  if (!metadata.isDirectory()) return;

  const entries = await readdir(treePath);
  await Promise.all(
    entries.map((entry) =>
      assertTreeHasNoSymbolicLinks(resolve(treePath, entry)),
    ),
  );
}

async function assertTrustedDirectoryPath(directoryPath) {
  const { root } = parse(directoryPath);
  const components = relative(root, directoryPath).split(sep).filter(Boolean);
  let currentPath = root;

  for (const component of components) {
    currentPath = resolve(currentPath, component);
    const metadata = await lstat(currentPath);
    if (metadata.isSymbolicLink()) {
      throw new GitWorkerError('Repository parent contains a symbolic link');
    }
    if (!metadata.isDirectory()) {
      throw new GitWorkerError('Repository parent must contain only directories');
    }
  }
}

async function createGitControlDirectory(controlDirectory) {
  await Promise.all([
    mkdir(resolve(controlDirectory, 'hooks'), { recursive: true }),
    mkdir(resolve(controlDirectory, 'home'), { recursive: true }),
    mkdir(resolve(controlDirectory, 'xdg'), { recursive: true }),
  ]);
  const configHandle = await open(
    resolve(controlDirectory, 'global.config'),
    'wx',
    0o600,
  );
  await configHandle.close();
}

export class GitWorker {
  #fixtureDir;
  #repoDir;
  #processRunner;
  #stage = 'uninitialized';
  #initialCommit;
  #gitIdentity;

  constructor({ fixtureDir, repoDir, processRunner = runProcess }) {
    if (typeof fixtureDir !== 'string' || typeof repoDir !== 'string') {
      throw new TypeError('fixtureDir and repoDir must be paths');
    }
    if (typeof processRunner !== 'function') {
      throw new TypeError('processRunner must be a function');
    }

    this.#fixtureDir = resolve(fixtureDir);
    this.#repoDir = resolve(repoDir);
    this.#processRunner = processRunner;

    if (
      isWithin(this.#fixtureDir, this.#repoDir) ||
      isWithin(this.#repoDir, this.#fixtureDir)
    ) {
      throw new GitWorkerError('fixtureDir and repoDir must be separate trees');
    }
  }

  async initialize() {
    if (this.#stage !== 'uninitialized') {
      throw new GitWorkerError('Git worker has already been initialized');
    }

    const repositoryParent = dirname(this.#repoDir);
    let stagingDirectory;
    this.#stage = 'initializing';
    try {
      await assertTrustedDirectoryPath(repositoryParent);
      await this.#assertRepositoryDoesNotExist();
      await assertTreeHasNoSymbolicLinks(this.#fixtureDir);
      stagingDirectory = await mkdtemp(
        resolve(repositoryParent, `.${basename(this.#repoDir)}.staging-`),
      );
      const fixtureEntries = await readdir(this.#fixtureDir);
      await Promise.all(
        fixtureEntries.map((entry) =>
          cp(
            resolve(this.#fixtureDir, entry),
            resolve(stagingDirectory, entry),
            { recursive: true, errorOnExist: true, force: false },
          ),
        ),
      );
      const bootstrapGitControl = resolve(
        stagingDirectory,
        '.superagent-git-control',
      );
      await createGitControlDirectory(bootstrapGitControl);
      await this.#git(
        ['init', '--initial-branch=main'],
        stagingDirectory,
        bootstrapGitControl,
      );
      await rename(
        bootstrapGitControl,
        resolve(stagingDirectory, '.git/superagent-control'),
      );
      await this.#git(
        ['config', '--local', 'user.name', 'SuperAgent Demo'],
        stagingDirectory,
      );
      await this.#git([
        'config',
        '--local',
        'user.email',
        'superagent-demo@example.invalid',
      ], stagingDirectory);
      await this.#git(['add', '--all'], stagingDirectory);
      await this.#git(
        ['commit', '-m', INITIAL_COMMIT_MESSAGE],
        stagingDirectory,
      );
      const initialCommit = (
        await this.#git(['rev-parse', 'HEAD'], stagingDirectory)
      ).stdout.trim();
      await assertTrustedDirectoryPath(repositoryParent);
      await this.#assertRepositoryDoesNotExist();
      await rename(stagingDirectory, this.#repoDir);
      stagingDirectory = undefined;
      this.#gitIdentity = await this.#captureGitIdentity();
      this.#initialCommit = initialCommit;
      this.#stage = 'ready';

      return { branch: 'main', initialCommit: this.#initialCommit };
    } catch (cause) {
      if (stagingDirectory) {
        try {
          await rm(stagingDirectory, { recursive: true, force: true });
        } catch (cleanupError) {
          cause = new AggregateError(
            [cause, cleanupError],
            'Repository initialization and staging cleanup both failed',
          );
        }
      }
      this.#stage = 'uninitialized';
      throw this.#wrapError(
        'Failed to initialize the runtime repository',
        cause,
        stagingDirectory ? [stagingDirectory] : [],
      );
    }
  }

  async runAssignment(phase) {
    if (!['initial', 'follow-up'].includes(phase)) {
      throw new GitWorkerError(`Invalid assignment phase: ${String(phase)}`);
    }
    if (this.#stage === 'uninitialized') {
      throw new GitWorkerError('Git worker must be initialized first');
    }

    const expectedStage = phase === 'initial' ? 'ready' : 'initial-complete';
    if (this.#stage !== expectedStage) {
      throw new GitWorkerError(
        `Cannot run ${phase} assignment while worker is ${this.#stage}`,
      );
    }

    const writeTargets =
      phase === 'initial'
        ? [TEST_FILE, IMPLEMENTATION_FILE]
        : [TEST_FILE, IMPLEMENTATION_FILE, README_FILE];
    try {
      await this.#assertSafeWriteTargets(writeTargets);
    } catch (cause) {
      throw this.#wrapError(
        `Failed to validate ${phase} assignment write targets`,
        cause,
      );
    }
    const checkpoint = await this.#captureAssignmentCheckpoint();
    this.#stage = `${phase}-running`;
    try {
      const result =
        phase === 'initial'
          ? await this.#runInitialAssignment()
          : await this.#runFollowUpAssignment();
      this.#stage = phase === 'initial' ? 'initial-complete' : 'complete';
      return result;
    } catch (cause) {
      try {
        await this.#assertSafeWriteTargets(writeTargets);
        await this.#rollbackAssignment(checkpoint);
        this.#stage = checkpoint.stage;
      } catch (rollbackCause) {
        this.#stage = 'failed';
        cause = new AggregateError(
          [cause, rollbackCause],
          'Assignment execution and rollback both failed',
        );
      }
      throw this.#wrapError(`Failed to run ${phase} assignment`, cause);
    }
  }

  async #runInitialAssignment() {
    await this.#git(['checkout', '-b', ASSIGNMENT_BRANCH]);
    await this.#appendToFile(TEST_FILE, FIRST_REGRESSION_TEST);
    const redResult = await this.#runTests();
    this.#requireRed(
      redResult,
      'returns zero for a 100 percent discount',
    );

    await this.#replaceInFile(
      IMPLEMENTATION_FILE,
      'discountPercent >= 100',
      'discountPercent > 100',
    );
    const greenResult = await this.#runTests(true);
    await this.#commit([IMPLEMENTATION_FILE, TEST_FILE], FIRST_COMMIT_MESSAGE);

    return this.#createResult(redResult, greenResult);
  }

  async #runFollowUpAssignment() {
    await this.#appendToFile(TEST_FILE, FOLLOW_UP_REGRESSION_TEST);
    const redResult = await this.#runTests();
    this.#requireRed(redResult, 'rejects non-finite inputs');

    await this.#replaceInFile(
      IMPLEMENTATION_FILE,
      "typeof amount !== 'number' || amount < 0",
      '!Number.isFinite(amount) || amount < 0',
    );
    await this.#replaceInFile(
      IMPLEMENTATION_FILE,
      "typeof discountPercent !== 'number' ||",
      '!Number.isFinite(discountPercent) ||',
    );
    await this.#replaceInFile(
      IMPLEMENTATION_FILE,
      'amount must be a non-negative number',
      'finite amount must be greater than or equal to zero',
    );
    await this.#replaceInFile(
      IMPLEMENTATION_FILE,
      'discountPercent must be between 0 and 100',
      'finite discountPercent must be between 0 and 100',
    );
    await this.#appendToFile(README_FILE, FOLLOW_UP_DOCUMENTATION.trim());
    const greenResult = await this.#runTests(true);
    await this.#commit(
      [IMPLEMENTATION_FILE, README_FILE, TEST_FILE],
      FOLLOW_UP_COMMIT_MESSAGE,
    );

    return this.#createResult(redResult, greenResult);
  }

  async #captureAssignmentCheckpoint() {
    const [branchResult, headResult, assignmentBranchResult] =
      await Promise.all([
        this.#git(['branch', '--show-current']),
        this.#git(['rev-parse', 'HEAD']),
        this.#git([
          'branch',
          '--list',
          '--format=%(refname:short)',
          ASSIGNMENT_BRANCH,
        ]),
      ]);

    return Object.freeze({
      stage: this.#stage,
      branch: branchResult.stdout.trim(),
      head: headResult.stdout.trim(),
      assignmentBranchExisted:
        assignmentBranchResult.stdout.trim() === ASSIGNMENT_BRANCH,
    });
  }

  #gitIdentityPaths() {
    const gitDirectory = resolve(this.#repoDir, '.git');
    const controlDirectory = resolve(gitDirectory, 'superagent-control');
    return [
      { path: this.#repoDir, kind: 'directory' },
      { path: gitDirectory, kind: 'directory' },
      { path: controlDirectory, kind: 'directory' },
      { path: resolve(controlDirectory, 'home'), kind: 'directory' },
      { path: resolve(controlDirectory, 'xdg'), kind: 'directory' },
      { path: resolve(controlDirectory, 'hooks'), kind: 'directory' },
      { path: resolve(controlDirectory, 'global.config'), kind: 'file' },
    ];
  }

  async #captureGitIdentity() {
    let identities = [];
    try {
      for (const { path, kind } of this.#gitIdentityPaths()) {
        const metadata = await lstat(path);
        const hasExpectedKind =
          kind === 'directory'
            ? metadata.isDirectory()
            : metadata.isFile();
        if (metadata.isSymbolicLink() || !hasExpectedKind) {
          throw new GitWorkerError('Git metadata identity is invalid');
        }
        const canonicalPath = await realpath(path);
        if (!isWithin(this.#repoDir, canonicalPath)) {
          throw new GitWorkerError('Git metadata identity escapes repository');
        }
        identities = [
          ...identities,
          Object.freeze({
            path,
            kind,
            canonicalPath,
            device: metadata.dev,
            inode: metadata.ino,
          }),
        ];
      }
    } catch (cause) {
      if (cause instanceof GitWorkerError) throw cause;
      throw new GitWorkerError('Git metadata identity is unavailable', {
        cause,
      });
    }
    return Object.freeze(identities);
  }

  async #assertGitIdentity() {
    if (!this.#gitIdentity) {
      throw new GitWorkerError('Git metadata identity was not recorded');
    }
    const currentIdentity = await this.#captureGitIdentity();
    const matches = currentIdentity.every((current, index) => {
      const expected = this.#gitIdentity[index];
      return (
        expected !== undefined &&
        current.path === expected.path &&
        current.kind === expected.kind &&
        current.canonicalPath === expected.canonicalPath &&
        current.device === expected.device &&
        current.inode === expected.inode
      );
    });
    if (!matches || currentIdentity.length !== this.#gitIdentity.length) {
      throw new GitWorkerError('Git metadata identity changed');
    }
  }

  async #rollbackAssignment(checkpoint) {
    await this.#git(['reset', '--hard', checkpoint.head]);
    await this.#git(['clean', '-fd']);
    if (checkpoint.branch) {
      await this.#git(['checkout', '--force', checkpoint.branch]);
    } else {
      await this.#git(['checkout', '--detach', checkpoint.head]);
    }
    await this.#git(['reset', '--hard', checkpoint.head]);

    if (
      checkpoint.branch !== ASSIGNMENT_BRANCH &&
      !checkpoint.assignmentBranchExisted
    ) {
      const assignmentBranchResult = await this.#git([
        'branch',
        '--list',
        '--format=%(refname:short)',
        ASSIGNMENT_BRANCH,
      ]);
      if (assignmentBranchResult.stdout.trim() === ASSIGNMENT_BRANCH) {
        await this.#git(['branch', '-D', ASSIGNMENT_BRANCH]);
      }
    }
  }

  async #assertRepositoryDoesNotExist() {
    try {
      const metadata = await lstat(this.#repoDir);
      if (metadata.isSymbolicLink()) {
        throw new GitWorkerError('Runtime repository cannot be a symbolic link');
      }
      throw new GitWorkerError('Runtime repository path already exists');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  async #appendToFile(relativePath, section) {
    const filePath = this.#repositoryPath(relativePath);
    await this.#assertSafeWritePath(filePath);
    const source = await readFile(filePath, 'utf8');
    await this.#writeFileAtomically(filePath, appendSection(source, section));
  }

  async #replaceInFile(relativePath, original, replacement) {
    const filePath = this.#repositoryPath(relativePath);
    await this.#assertSafeWritePath(filePath);
    const source = await readFile(filePath, 'utf8');
    const updatedSource = replaceOnce(source, original, replacement, relativePath);
    await this.#writeFileAtomically(filePath, updatedSource);
  }

  async #writeFileAtomically(filePath, content) {
    const targetMetadata = await this.#assertSafeWritePath(filePath);
    const temporaryPath = resolve(
      dirname(filePath),
      `.${basename(filePath)}.${randomUUID()}.tmp`,
    );
    let temporaryHandle;
    let temporaryFileExists = false;
    let failure;

    try {
      temporaryHandle = await open(
        temporaryPath,
        'wx',
        targetMetadata.mode & 0o777,
      );
      temporaryFileExists = true;
      await temporaryHandle.writeFile(content, 'utf8');
      await temporaryHandle.sync();
      await temporaryHandle.close();
      temporaryHandle = undefined;
      await this.#assertSafeWritePath(temporaryPath);
      await this.#assertSafeWritePath(filePath);
      await rename(temporaryPath, filePath);
      temporaryFileExists = false;
    } catch (cause) {
      failure = cause;
    }

    if (temporaryHandle) {
      try {
        await temporaryHandle.close();
      } catch (closeError) {
        failure = new AggregateError(
          [failure, closeError].filter(Boolean),
          'Atomic write and temporary file close both failed',
        );
      }
    }
    if (temporaryFileExists) {
      try {
        await unlink(temporaryPath);
      } catch (cleanupError) {
        if (cleanupError.code !== 'ENOENT') {
          failure = new AggregateError(
            [failure, cleanupError].filter(Boolean),
            'Atomic write and temporary file cleanup both failed',
          );
        }
      }
    }
    if (failure) throw failure;
  }

  async #assertSafeWriteTargets(relativePaths) {
    await Promise.all(
      relativePaths.map((relativePath) =>
        this.#assertSafeWritePath(this.#repositoryPath(relativePath)),
      ),
    );
  }

  async #assertSafeWritePath(filePath) {
    const repositoryMetadata = await lstat(this.#repoDir);
    if (
      repositoryMetadata.isSymbolicLink() ||
      !repositoryMetadata.isDirectory()
    ) {
      throw new GitWorkerError('Runtime repository must be a real directory');
    }

    const realRepositoryDirectory = await realpath(this.#repoDir);
    if (realRepositoryDirectory !== this.#repoDir) {
      throw new GitWorkerError('Runtime repository path contains a symbolic link');
    }

    const pathFromRepository = relative(this.#repoDir, filePath);
    let currentPath = this.#repoDir;
    const components = pathFromRepository.split(sep);
    let targetMetadata;
    for (const [index, component] of components.entries()) {
      currentPath = resolve(currentPath, component);
      const metadata = await lstat(currentPath);
      if (metadata.isSymbolicLink()) {
        throw new GitWorkerError(
          `Symbolic link is not allowed in runtime repository: ${currentPath}`,
        );
      }
      const isTarget = index === components.length - 1;
      if (!isTarget && !metadata.isDirectory()) {
        throw new GitWorkerError('Runtime write parent must be a directory');
      }
      if (isTarget && !metadata.isFile()) {
        throw new GitWorkerError('Runtime write target must be a regular file');
      }
      if (!metadata.isDirectory() && metadata.nlink > 1) {
        throw new GitWorkerError(
          `Hard link is not allowed in runtime repository: ${currentPath}`,
        );
      }
      if (isTarget) targetMetadata = metadata;
    }

    const realParentDirectory = await realpath(dirname(filePath));
    if (!isWithin(realRepositoryDirectory, realParentDirectory)) {
      throw new GitWorkerError('Runtime write target escapes the repository');
    }
    return targetMetadata;
  }

  #repositoryPath(relativePath) {
    const filePath = resolve(this.#repoDir, relativePath);
    if (!isWithin(this.#repoDir, filePath) || filePath === this.#repoDir) {
      throw new GitWorkerError(`Refusing to write outside runtime repository`);
    }
    return filePath;
  }

  async #runTests(rejectOnNonZero = false) {
    const result = await this.#processRunner(process.execPath, ['--test'], {
      cwd: this.#repoDir,
      timeoutMs: 30_000,
      maxOutputBytes: 1_048_576,
      rejectOnNonZero,
      env: { ...TEST_ENVIRONMENT },
    });
    if (rejectOnNonZero) assertSuccessfulResult(result, 'Green test');
    return result;
  }

  #requireRed(result, expectedTestName) {
    const output = combineOutput(result);
    const diagnosticBoundary = output.indexOf('\n✖ failing tests:');
    const primaryOutput =
      diagnosticBoundary === -1
        ? output
        : output.slice(0, diagnosticBoundary);
    const failedTestNames = [
      ...Array.from(
        primaryOutput.matchAll(/^not ok \d+ - (.+)\r?$/gm),
        ([, testName]) => testName,
      ),
      ...Array.from(
        primaryOutput.matchAll(/^✖ (.+?)(?: \([\d.]+ms\))?\r?$/gm),
        ([, testName]) => testName,
      ),
    ];
    const failSummaries = Array.from(
      output.matchAll(/^(?:#|ℹ) fail (\d+)\r?$/gm),
      ([, failureCount]) => Number(failureCount),
    );
    const hasStrictRedEvidence =
      result.code === 1 &&
      result.signal === null &&
      result.timedOut === false &&
      result.outputTruncated === false &&
      failedTestNames.length === 1 &&
      failedTestNames[0] === expectedTestName &&
      failSummaries.length === 1 &&
      failSummaries[0] === 1;

    if (!hasStrictRedEvidence) {
      throw new GitWorkerError(
        `Regression test did not provide strict red evidence for ${expectedTestName}`,
      );
    }
  }

  async #commit(files, message) {
    await this.#git(['add', '--', ...files]);
    await this.#git(['commit', '-m', message]);
  }

  async #createResult(redResult, greenResult) {
    const [branchResult, logResult, patchResult, filesResult, statusResult] =
      await Promise.all([
        this.#git(['branch', '--show-current']),
        this.#git([
          'log',
          '--reverse',
          '--format=%H%x09%s',
          `${this.#initialCommit}..HEAD`,
        ]),
        this.#git(['diff', `${this.#initialCommit}..HEAD`, '--']),
        this.#git([
          'diff',
          '--name-only',
          `${this.#initialCommit}..HEAD`,
          '--',
        ]),
        this.#git(['status', '--short']),
      ]);

    if (branchResult.stdout.trim() !== ASSIGNMENT_BRANCH) {
      throw new GitWorkerError('Assignment completed on an unexpected branch');
    }
    if (statusResult.stdout !== '') {
      throw new GitWorkerError('Assignment left uncommitted changes');
    }

    const commits = logResult.stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [hash, ...messageParts] = line.split('\t');
        return { hash, message: messageParts.join('\t') };
      });
    const files = filesResult.stdout.trim().split('\n').filter(Boolean).sort();

    return sanitizeResult(
      {
        branch: ASSIGNMENT_BRANCH,
        commits,
        tests: {
          ok: true,
          command: TEST_COMMAND,
          output: combineOutput(greenResult),
          redEvidence: `exit code: ${redResult.code}\n${combineOutput(redResult)}`,
        },
        patch: patchResult.stdout,
        files,
      },
      this.#repoDir,
    );
  }

  async #git(
    args,
    cwd = this.#repoDir,
    controlDirectory = resolve(cwd, '.git/superagent-control'),
  ) {
    const usesRuntimeRepository = cwd === this.#repoDir;
    if (usesRuntimeRepository) await this.#assertGitIdentity();
    const gitEnvironment = {
      ...TEST_ENVIRONMENT,
      HOME: resolve(controlDirectory, 'home'),
      XDG_CONFIG_HOME: resolve(controlDirectory, 'xdg'),
      GIT_CONFIG_GLOBAL: resolve(controlDirectory, 'global.config'),
      GIT_CONFIG_NOSYSTEM: '1',
      ...(usesRuntimeRepository
        ? {
            GIT_DIR: resolve(this.#repoDir, '.git'),
            GIT_WORK_TREE: this.#repoDir,
          }
        : {}),
    };
    const isolatedArgs = [
      '-c',
      `core.hooksPath=${resolve(controlDirectory, 'hooks')}`,
      ...args,
    ];
    const result = await this.#processRunner('git', isolatedArgs, {
      cwd,
      timeoutMs: 30_000,
      maxOutputBytes: 1_048_576,
      rejectOnNonZero: true,
      env: gitEnvironment,
    });
    assertSuccessfulResult(result, 'Git command');
    return result;
  }

  #wrapError(message, cause, additionalPaths = []) {
    const privatePaths = [
      [this.#fixtureDir, '<fixture>'],
      [this.#repoDir, '<repo>'],
      ...additionalPaths.map((privatePath) => [privatePath, '<staging>']),
    ];
    const sanitizePublicText = (value) =>
      privatePaths.reduce(
        (sanitized, [privatePath, replacement]) =>
          sanitizeResult(sanitized, privatePath, replacement),
        value,
      );
    if (cause instanceof GitWorkerError) {
      const publicMessage = sanitizePublicText(cause.message);
      if (publicMessage === cause.message) return cause;
      return new GitWorkerError(publicMessage, { cause });
    }
    if (cause instanceof ProcessError && cause.result) {
      const detail = sanitizePublicText(combineOutput(cause.result));
      const publicMessage = detail ? `${message}: ${detail}` : message;
      return new GitWorkerError(sanitizePublicText(publicMessage), { cause });
    }
    return new GitWorkerError(sanitizePublicText(message), { cause });
  }
}
