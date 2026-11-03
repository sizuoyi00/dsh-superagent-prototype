import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { checkLiveReadiness } from '../src/doctor.mjs';
import { runProcess } from '../src/process.mjs';

const CHECKOUT_DIRECTORY = '/workspace/dsh-superagent';
const REAL_CHECKOUT_DIRECTORY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../..',
);

function processResult(stdout = '', overrides = {}) {
  return Object.freeze({
    stdout,
    stderr: '',
    code: 0,
    signal: null,
    timedOut: false,
    outputTruncated: false,
    ...overrides,
  });
}

function availableResponses(overrides = {}) {
  return new Map([
    ['git --version', processResult('git version 2.46.0\n')],
    ['gh --version', processResult('gh version 2.50.0 (2025-02-05)\n')],
    ['gh auth status', processResult('Logged in to github.com\n')],
    ['dsh --version', processResult('dsh 0.2.1-alpha.2\n')],
    [
      'git rev-parse --is-inside-work-tree',
      processResult('true\n'),
    ],
    ...Object.entries(overrides),
  ]);
}

function createProbe(responses = availableResponses()) {
  const calls = [];
  const probe = async (command, args, options) => {
    calls.push({ command, args: [...args], options: { ...options } });
    const key = [command, ...args].join(' ');
    if (!responses.has(key)) {
      throw new Error(`Unexpected command probe: ${key}`);
    }
    const response = responses.get(key);
    if (response instanceof Error) throw response;
    return response;
  };
  return { calls, probe };
}

async function runDoctor(overrides = {}) {
  const injected = createProbe(overrides.responses);
  const result = await checkLiveReadiness({
    cwd: CHECKOUT_DIRECTORY,
    nodeVersion: '22.19.0',
    probe: injected.probe,
    ...overrides.options,
  });
  return { ...injected, result };
}

async function captureRepositoryState() {
  const commands = [
    ['rev-parse', 'HEAD'],
    ['for-each-ref', '--format=%(refname):%(objectname)'],
    ['status', '--porcelain=v1', '--untracked-files=all'],
  ];
  const results = await Promise.all(
    commands.map((args) =>
      runProcess('git', args, {
        cwd: REAL_CHECKOUT_DIRECTORY,
        timeoutMs: 2_500,
        maxOutputBytes: 64 * 1024,
      }),
    ),
  );
  for (const result of results) {
    assert.equal(result.code, 0);
    assert.equal(result.timedOut, false);
  }
  return Object.freeze({
    head: results[0].stdout,
    refs: results[1].stdout,
    status: results[2].stdout,
  });
}

test('reports ready when every required live dependency is available', async () => {
  const { calls, result } = await runDoctor({
    options: {
      buildInfo: 'local bundle built',
      profileName: 'superagent',
    },
  });

  assert.equal(result.ready, true);
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(
    result.checks.map(({ id, status }) => ({ id, status })),
    [
      { id: 'node', status: 'ready' },
      { id: 'git', status: 'ready' },
      { id: 'gh', status: 'ready' },
      { id: 'gh-auth', status: 'ready' },
      { id: 'dsh', status: 'ready' },
      { id: 'source', status: 'ready' },
      { id: 'build', status: 'info' },
      { id: 'profile', status: 'info' },
    ],
  );
  for (const check of result.checks) {
    assert.equal(typeof check.label, 'string');
    assert.ok(check.label.length > 0);
    assert.equal(typeof check.detail, 'string');
    assert.ok(check.detail.length > 0);
    assert.equal(Object.isFrozen(check), true);
  }
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.checks), true);
  assert.equal(Object.isFrozen(result.blockers), true);
  assert.deepEqual(
    calls.map(({ command, args }) => [command, args]),
    [
      ['git', ['--version']],
      ['gh', ['--version']],
      ['gh', ['auth', 'status']],
      ['dsh', ['--version']],
      ['git', ['rev-parse', '--is-inside-work-tree']],
    ],
  );
  for (const call of calls) {
    assert.equal(call.options.cwd, CHECKOUT_DIRECTORY);
    assert.equal(call.options.shell, false);
    assert.ok(call.options.timeoutMs > 0);
    assert.ok(call.options.timeoutMs <= 5_000);
    assert.ok(call.options.maxOutputBytes <= 64 * 1024);
  }
});

test('reports missing commands as blockers without rejecting', async () => {
  const missingCommand = Object.assign(new Error('spawn ENOENT: /secret/bin'), {
    code: 'ENOENT',
  });
  const responses = availableResponses({
    'gh --version': missingCommand,
    'gh auth status': missingCommand,
    'dsh --version': missingCommand,
  });

  const { result } = await runDoctor({ responses });

  assert.equal(result.ready, false);
  assert.deepEqual(
    result.blockers.map(({ id }) => id),
    ['gh', 'gh-auth', 'dsh'],
  );
  assert.match(
    result.checks.find(({ id }) => id === 'gh').detail,
    /not installed/i,
  );
  assert.match(
    result.checks.find(({ id }) => id === 'dsh').detail,
    /not installed/i,
  );
});

test('enforces the project Node.js engine range', async () => {
  const cases = [
    ['22.18.0', 'blocked'],
    ['22.19.0', 'ready'],
    ['23.0.0', 'blocked'],
    ['24.0.0', 'ready'],
    ['25.6.1', 'ready'],
  ];

  for (const [nodeVersion, expectedStatus] of cases) {
    const { result } = await runDoctor({ options: { nodeVersion } });
    const nodeCheck = result.checks.find(({ id }) => id === 'node');

    assert.equal(nodeCheck.status, expectedStatus, nodeVersion);
    assert.equal(result.ready, expectedStatus === 'ready', nodeVersion);
  }
});

test('blocks an unsupported GitHub CLI version', async () => {
  const responses = availableResponses({
    'gh --version': processResult('gh version 2.47.9\n'),
  });

  const { result } = await runDoctor({ responses });

  assert.equal(result.ready, false);
  assert.deepEqual(
    result.blockers.map(({ id }) => id),
    ['gh'],
  );
  assert.match(
    result.checks.find(({ id }) => id === 'gh').detail,
    /requires GitHub CLI 2\.48 or newer/i,
  );
});

test('requires Git 2.32.0 or newer with a parseable version', async () => {
  const cases = [
    ['git version 2.31.9\n', 'blocked'],
    ['git version 2.32.0\n', 'ready'],
    ['git version unavailable\n', 'blocked'],
  ];

  for (const [versionOutput, expectedStatus] of cases) {
    const responses = availableResponses({
      'git --version': processResult(versionOutput),
    });
    const { result } = await runDoctor({ responses });
    const gitCheck = result.checks.find(({ id }) => id === 'git');

    assert.equal(gitCheck.status, expectedStatus, versionOutput.trim());
    assert.equal(result.ready, expectedStatus === 'ready', versionOutput.trim());
  }
});

test('enforces the supported DeepSeek Harness prerelease range', async () => {
  const cases = [
    ['dsh 0.1.9\n', 'blocked'],
    ['dsh 0.2.1-alpha.1\n', 'blocked'],
    ['dsh 0.2.1-alpha.02\n', 'blocked'],
    ['dsh 0.2.1-alpha.2\n', 'ready'],
    ['dsh 0.2.1-alpha.10\n', 'ready'],
    ['dsh 0.2.1-rc.1\n', 'ready'],
    ['dsh 0.2.1\n', 'ready'],
    ['dsh 0.2.9\n', 'ready'],
    ['dsh 0.3.0\n', 'blocked'],
    ['dsh version unavailable\n', 'blocked'],
  ];

  for (const [versionOutput, expectedStatus] of cases) {
    const responses = availableResponses({
      'dsh --version': processResult(versionOutput),
    });
    const { result } = await runDoctor({ responses });
    const dshCheck = result.checks.find(({ id }) => id === 'dsh');

    assert.equal(dshCheck.status, expectedStatus, versionOutput.trim());
    assert.equal(result.ready, expectedStatus === 'ready', versionOutput.trim());
  }
});

test('reports an unauthenticated GitHub CLI as a blocker', async () => {
  const responses = availableResponses({
    'gh auth status': processResult('', {
      code: 1,
      stderr: 'token ghp_do_not_return is invalid\n',
    }),
  });

  const { result } = await runDoctor({ responses });

  assert.equal(result.ready, false);
  assert.deepEqual(
    result.blockers.map(({ id }) => id),
    ['gh-auth'],
  );
  assert.match(
    result.checks.find(({ id }) => id === 'gh-auth').detail,
    /not authenticated/i,
  );
  assert.doesNotMatch(JSON.stringify(result), /ghp_do_not_return/);
});

test('blocks live mode when the source directory is not a Git checkout', async () => {
  const responses = availableResponses({
    'git rev-parse --is-inside-work-tree': processResult('false\n', {
      code: 128,
      stderr: 'fatal: not a git repository\n',
    }),
  });

  const { result } = await runDoctor({ responses });

  assert.equal(result.ready, false);
  assert.deepEqual(
    result.blockers.map(({ id }) => id),
    ['source'],
  );
  assert.match(
    result.checks.find(({ id }) => id === 'source').detail,
    /not a Git work tree/i,
  );
});

test('turns command timeouts and probe exceptions into safe blockers', async () => {
  const timeout = processResult('', {
    code: null,
    signal: 'SIGTERM',
    timedOut: true,
    stderr: 'SECRET_KEY=timeout-secret\n',
  });
  const responses = availableResponses({
    'git --version': timeout,
    'gh --version': new Error('probe failed with API_TOKEN=exception-secret'),
    'gh auth status': timeout,
    'dsh --version': new Error('dsh failed at /private/profile'),
    'git rev-parse --is-inside-work-tree': timeout,
  });

  const { result } = await runDoctor({ responses });

  assert.equal(result.ready, false);
  assert.deepEqual(
    result.blockers.map(({ id }) => id),
    ['git', 'gh', 'gh-auth', 'dsh', 'source'],
  );
  assert.match(
    result.checks.find(({ id }) => id === 'git').detail,
    /timed out/i,
  );
  assert.match(
    result.checks.find(({ id }) => id === 'gh').detail,
    /could not be checked/i,
  );
  assert.doesNotMatch(
    JSON.stringify(result),
    /timeout-secret|exception-secret|private\/profile/,
  );
});

test('never returns command output, tokens, or environment dumps', async () => {
  const sensitiveMarker = ['ghp', 'sensitive', 'value', '123456789'].join('_');
  const environmentDump = 'HOME=/private/home API_TOKEN=environment-secret';
  const responses = availableResponses({
    'git --version': processResult(
      `git version 2.46.0\n${environmentDump}\n`,
    ),
    'gh --version': processResult(
      `gh version 2.50.0\ntoken=${sensitiveMarker}\n`,
    ),
    'gh auth status': processResult(`Logged in with ${sensitiveMarker}\n`),
    'dsh --version': processResult(
      `dsh 0.2.1-alpha.2\n${environmentDump}\n`,
    ),
    'git rev-parse --is-inside-work-tree': processResult(
      `true\n${environmentDump}\n`,
    ),
  });

  const { result } = await runDoctor({ responses });
  const serialized = JSON.stringify(result);

  assert.equal(result.ready, true);
  assert.doesNotMatch(serialized, /ghp_sensitive_value/);
  assert.doesNotMatch(serialized, /environment-secret|private\/home/);
  assert.doesNotMatch(serialized, /Logged in with/);
});

test('the real process adapter leaves repository state unchanged', async (t) => {
  try {
    const before = await captureRepositoryState();
    const result = await checkLiveReadiness({ cwd: REAL_CHECKOUT_DIRECTORY });
    const after = await captureRepositoryState();

    assert.equal(typeof result.ready, 'boolean');
    assert.deepEqual(
      result.checks.map(({ id }) => id),
      ['node', 'git', 'gh', 'gh-auth', 'dsh', 'source'],
    );
    assert.deepEqual(after, before);
  } catch (error) {
    if (error?.cause?.code === 'ENOENT') {
      t.skip('Git is unavailable for the real-adapter smoke test');
      return;
    }
    throw error;
  }
});
