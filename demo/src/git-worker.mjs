import { cp, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

import { ProcessError, runProcess } from './process.mjs';

export const ASSIGNMENT_BRANCH = 'agent/demo-discount-boundary';

const INITIAL_COMMIT_MESSAGE = 'chore: initialize discount fixture';
const FIRST_COMMIT_MESSAGE = 'fix: support 100 percent discounts';
const FOLLOW_UP_COMMIT_MESSAGE = 'fix: reject non-finite discount inputs';
const TEST_FILE = 'test/discount.test.mjs';
const IMPLEMENTATION_FILE = 'src/discount.mjs';
const README_FILE = 'README.md';
const TEST_COMMAND = 'node --test';
const { NODE_TEST_CONTEXT: ignoredTestContext, ...TEST_ENVIRONMENT } = process.env;

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

export class GitWorker {
  #fixtureDir;
  #repoDir;
  #processRunner;
  #stage = 'uninitialized';
  #initialCommit;

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

    this.#stage = 'initializing';
    try {
      await this.#assertRepositoryDoesNotExist();
      await mkdir(dirname(this.#repoDir), { recursive: true });
      await cp(this.#fixtureDir, this.#repoDir, {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
      await this.#git(['init', '--initial-branch=main']);
      await this.#git(['config', '--local', 'user.name', 'SuperAgent Demo']);
      await this.#git([
        'config',
        '--local',
        'user.email',
        'superagent-demo@example.invalid',
      ]);
      await this.#git(['add', '--all']);
      await this.#git(['commit', '-m', INITIAL_COMMIT_MESSAGE]);
      this.#initialCommit = (await this.#git(['rev-parse', 'HEAD'])).stdout.trim();
      this.#stage = 'ready';

      return { branch: 'main', initialCommit: this.#initialCommit };
    } catch (cause) {
      this.#stage = 'failed';
      throw this.#wrapError('Failed to initialize the runtime repository', cause);
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

    this.#stage = `${phase}-running`;
    try {
      const result =
        phase === 'initial'
          ? await this.#runInitialAssignment()
          : await this.#runFollowUpAssignment();
      this.#stage = phase === 'initial' ? 'initial-complete' : 'complete';
      return result;
    } catch (cause) {
      this.#stage = 'failed';
      throw this.#wrapError(`Failed to run ${phase} assignment`, cause);
    }
  }

  async #runInitialAssignment() {
    await this.#git(['checkout', '-b', ASSIGNMENT_BRANCH]);
    await this.#appendToFile(TEST_FILE, FIRST_REGRESSION_TEST);
    const redResult = await this.#runTests();
    this.#requireRed(redResult, '100 percent discount');

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
    this.#requireRed(redResult, 'non-finite inputs');

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

  async #assertRepositoryDoesNotExist() {
    try {
      await lstat(this.#repoDir);
      throw new GitWorkerError('Runtime repository path already exists');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  async #appendToFile(relativePath, section) {
    const filePath = this.#repositoryPath(relativePath);
    const source = await readFile(filePath, 'utf8');
    await writeFile(filePath, appendSection(source, section), 'utf8');
  }

  async #replaceInFile(relativePath, original, replacement) {
    const filePath = this.#repositoryPath(relativePath);
    const source = await readFile(filePath, 'utf8');
    const updatedSource = replaceOnce(source, original, replacement, relativePath);
    await writeFile(filePath, updatedSource, 'utf8');
  }

  #repositoryPath(relativePath) {
    const filePath = resolve(this.#repoDir, relativePath);
    if (!isWithin(this.#repoDir, filePath) || filePath === this.#repoDir) {
      throw new GitWorkerError(`Refusing to write outside runtime repository`);
    }
    return filePath;
  }

  async #runTests(rejectOnNonZero = false) {
    return this.#processRunner(process.execPath, ['--test'], {
      cwd: this.#repoDir,
      timeoutMs: 30_000,
      maxOutputBytes: 1_048_576,
      rejectOnNonZero,
      env: TEST_ENVIRONMENT,
    });
  }

  #requireRed(result, expectedTestName) {
    const output = combineOutput(result);
    if (result.code === 0 || !output.includes(expectedTestName)) {
      throw new GitWorkerError(
        `Regression test did not fail for ${expectedTestName}`,
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

    return {
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
    };
  }

  async #git(args) {
    return this.#processRunner('git', args, {
      cwd: this.#repoDir,
      timeoutMs: 30_000,
      maxOutputBytes: 1_048_576,
      rejectOnNonZero: true,
    });
  }

  #wrapError(message, cause) {
    if (cause instanceof GitWorkerError) return cause;
    if (cause instanceof ProcessError && cause.result) {
      const detail = combineOutput(cause.result);
      return new GitWorkerError(detail ? `${message}: ${detail}` : message, {
        cause,
      });
    }
    return new GitWorkerError(message, { cause });
  }
}
