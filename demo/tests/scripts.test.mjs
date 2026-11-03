import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const demoDirectory = resolve(testDirectory, '..');
const repositoryDirectory = resolve(demoDirectory, '..');
const startScript = join(demoDirectory, 'start.sh');
const verifyScript = join(demoDirectory, 'verify.sh');

async function createTemporaryDirectory(t, prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function createTapNode(t, summary) {
  const binaryDirectory = await createTemporaryDirectory(t, 'superagent-fake-node-');
  const nodePath = join(binaryDirectory, 'node');
  const source = `#!/bin/sh
case \${1-} in
  -e|--check)
    exit 0
    ;;
  --test)
    printf '%s\\n' \\
      'TAP version 13' \\
      '1..${summary.tests}' \\
      '# tests ${summary.tests}' \\
      '# suites 0' \\
      '# pass ${summary.pass}' \\
      '# fail ${summary.fail}' \\
      '# cancelled ${summary.cancelled}' \\
      '# skipped ${summary.skipped}' \\
      '# todo ${summary.todo}'
    exit 0
    ;;
esac
printf 'unexpected fake node arguments\\n' >&2
exit 99
`;
  await writeFile(nodePath, source, 'utf8');
  await chmod(nodePath, 0o755);
  return binaryDirectory;
}

function extractCleanupSnippet(source) {
  const match = source.match(
    /- \*\*清理默认 runtime：\*\*[\s\S]*?```sh\n([\s\S]*?)\n```/,
  );
  assert.ok(match, 'README cleanup shell block must exist');
  return match[1];
}

function withCleanupRepository(snippet, repositoryPath) {
  const quotedPath = `'${repositoryPath.replaceAll("'", "'\\''")}'`;
  return snippet.replace(
    'repo=/absolute/path/to/dsh-superagent',
    `repo=${quotedPath}`,
  );
}

async function reserveLoopbackPort() {
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
  return address.port;
}

function runScript(scriptPath, options = {}) {
  return spawnSync(scriptPath, [], {
    cwd: options.cwd,
    encoding: 'utf8',
    env: options.env,
    timeout: options.timeout ?? 120_000,
  });
}

function startChild(scriptPath, options) {
  const child = spawn(scriptPath, [], {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  return {
    child,
    stderr: () => stderr,
    stdout: () => stdout,
  };
}

async function waitForHttpState(url, childHandle, timeoutMs = 10_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (childHandle.child.exitCode !== null) {
      throw new Error(
        `start.sh exited early (${childHandle.child.exitCode}): ${childHandle.stderr()}`,
      );
    }
    try {
      const response = await fetch(`${url}/api/state`);
      if (response.ok) return response.json();
    } catch {
      // Process startup and successful listening are asynchronous; retry briefly.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(
    `Timed out waiting for ${url}. stdout=${childHandle.stdout()} stderr=${childHandle.stderr()}`,
  );
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolveExit) => child.once('exit', resolveExit)),
    new Promise((resolveTimeout) => setTimeout(resolveTimeout, 2_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await new Promise((resolveExit) => child.once('exit', resolveExit));
  }
}

test('operator scripts are executable POSIX sh programs with strict mode', async () => {
  for (const scriptPath of [startScript, verifyScript]) {
    const [source, metadata] = await Promise.all([
      readFile(scriptPath, 'utf8'),
      stat(scriptPath),
    ]);
    assert.match(source, /^#!\/bin\/sh\n/);
    assert.match(source, /^set -eu$/m);
    assert.match(source, /dirname\s+"\$0"/);
    assert.match(source, /CDPATH=/);
    assert.notEqual(metadata.mode & 0o111, 0, `${scriptPath} must be executable`);
  }
});

test('start contract validates explicit environment and execs the server safely', async () => {
  const source = await readFile(startScript, 'utf8');
  assert.match(source, /DEMO_PORT/);
  assert.match(source, /DEMO_RUNTIME_DIR/);
  assert.match(source, /exec\s+env\s+-i/);
  assert.match(source, /src\/server\.mjs/);
  assert.doesNotMatch(source, /\beval\b/);
  assert.doesNotMatch(source, /\bsource\b/);
  assert.doesNotMatch(source, /(^|[;&|]\s*)rm\s/m);
});

test('verify contract runs fixture, demo, syntax, and whitespace checks without package tools', async () => {
  const source = await readFile(verifyScript, 'utf8');
  assert.match(source, /fixture\/test/);
  assert.match(source, /tests\/\*\.test\.mjs/);
  assert.match(source, /EXPECTED_FIXTURE_TESTS=4/);
  assert.match(source, /EXPECTED_DEMO_TESTS=153/);
  assert.match(source, /env\s+-i/);
  assert.match(source, /--test-reporter=tap/);
  assert.match(
    source,
    /if \[ "\$\{DEMO_VERIFY_NESTED-\}" = 1 \]; then/,
  );
  assert.match(source, /--check/);
  assert.match(source, /git\s+-C\s+"\$REPO_DIR"\s+diff\s+--check/);
  assert.doesNotMatch(source, /\b(?:npm|pnpm|yarn|bun|curl|wget)\b/);
});

test('verify succeeds from a different working directory', async (t) => {
  if (process.env.DEMO_VERIFY_NESTED === '1') {
    assert.equal(process.env.DEMO_VERIFY_NESTED, '1');
    return;
  }
  const workingDirectory = await createTemporaryDirectory(t, 'superagent-verify-cwd-');
  const result = runScript(verifyScript, {
    cwd: workingDirectory,
    env: {
      ...process.env,
      DEMO_VERIFY_NESTED: '1',
      NODE_OPTIONS: '--definitely-invalid-superagent-option',
      NODE_TEST_CONTEXT: 'child-v8',
      NODE_V8_COVERAGE: join(workingDirectory, 'unexpected-coverage'),
    },
  });

  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Fixture tests:\s+4\/4 passed/);
  assert.match(result.stdout, /Demo tests:\s+153\/153 passed/);
  assert.match(result.stdout, /Syntax checks:\s+\d+ file/);
  assert.match(result.stdout, /Verification complete:/);
  assert.deepEqual(await readdir(workingDirectory), []);
});

test('verify rejects wrong inventory and every non-passing TAP outcome', async (t) => {
  const passingSummary = {
    tests: 4,
    pass: 4,
    fail: 0,
    cancelled: 0,
    skipped: 0,
    todo: 0,
  };
  const scenarios = [
    { label: 'inventory', summary: { ...passingSummary, tests: 3, pass: 3 } },
    { label: 'fail', summary: { ...passingSummary, fail: 1 } },
    { label: 'cancelled', summary: { ...passingSummary, cancelled: 1 } },
    { label: 'skipped', summary: { ...passingSummary, skipped: 1 } },
    { label: 'todo', summary: { ...passingSummary, todo: 1 } },
  ];

  for (const { label, summary } of scenarios) {
    const binaryDirectory = await createTapNode(t, summary);
    const result = runScript(verifyScript, {
      cwd: repositoryDirectory,
      env: {
        PATH: `${binaryDirectory}:${process.env.PATH}`,
      },
    });

    assert.equal(result.error, undefined, `${label}: ${result.error?.message}`);
    assert.notEqual(result.status, 0, `${label} unexpectedly succeeded`);
    assert.match(result.stderr, /TAP summary expected 4 tests and passes/, label);
  }
});

test('start launches from a different cwd and writes only to the configured runtime', async (t) => {
  const workingDirectory = await createTemporaryDirectory(t, 'superagent-start-cwd-');
  const runtimeDirectory = join(workingDirectory, 'chosen-runtime');
  const sentinelPath = join(workingDirectory, 'sentinel.txt');
  await writeFile(sentinelPath, 'unchanged\n', 'utf8');
  const port = await reserveLoopbackPort();
  const url = `http://127.0.0.1:${port}`;
  const childHandle = startChild(startScript, {
    cwd: workingDirectory,
    env: {
      ...process.env,
      DEMO_PORT: String(port),
      DEMO_RUNTIME_DIR: runtimeDirectory,
    },
  });
  t.after(() => stopChild(childHandle.child));

  const state = await waitForHttpState(url, childHandle);
  assert.equal(state.phase, 'ready');
  const doctorResponse = await fetch(`${url}/api/doctor`);
  assert.equal(doctorResponse.status, 200);
  const doctor = await doctorResponse.json();
  const sourceCheck = doctor.checks.find(({ id }) => id === 'source');
  assert.equal(sourceCheck?.status, 'ready');
  assert.match(childHandle.stdout(), new RegExp(url.replaceAll('.', '\\.')));
  assert.match(childHandle.stdout(), /本地实战模式/);
  assert.match(childHandle.stdout(), /Ctrl\+C/);
  assert.match(childHandle.stdout(), /verify\.sh/);
  assert.match(childHandle.stdout(), new RegExp(runtimeDirectory.replaceAll('/', '\\/')));

  await stopChild(childHandle.child);
  assert.deepEqual((await readdir(workingDirectory)).sort(), [
    'chosen-runtime',
    'sentinel.txt',
  ]);
  assert.equal(await readFile(sentinelPath, 'utf8'), 'unchanged\n');
});

test('start rejects a blank port without changing a sentinel', async (t) => {
  const workingDirectory = await createTemporaryDirectory(t, 'superagent-empty-port-');
  const sentinelPath = join(workingDirectory, 'sentinel.txt');
  await writeFile(sentinelPath, 'unchanged\n', 'utf8');
  const result = runScript(startScript, {
    cwd: workingDirectory,
    env: {
      ...process.env,
      DEMO_PORT: '',
      DEMO_RUNTIME_DIR: join(workingDirectory, 'runtime'),
    },
    timeout: 5_000,
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DEMO_PORT/);
  assert.deepEqual(await readdir(workingDirectory), ['sentinel.txt']);
  assert.equal(await readFile(sentinelPath, 'utf8'), 'unchanged\n');
});

test('start rejects invalid or occupied ports without false readiness', async (t) => {
  for (const port of ['0', '65536']) {
    const workingDirectory = await createTemporaryDirectory(
      t,
      `superagent-invalid-port-${port}-`,
    );
    const sentinelPath = join(workingDirectory, 'sentinel.txt');
    await writeFile(sentinelPath, 'unchanged\n', 'utf8');
    const result = runScript(startScript, {
      cwd: workingDirectory,
      env: {
        ...process.env,
        DEMO_PORT: port,
        DEMO_RUNTIME_DIR: join(workingDirectory, 'runtime'),
      },
      timeout: 5_000,
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /DEMO_PORT|port/i);
    assert.deepEqual(await readdir(workingDirectory), ['sentinel.txt']);
    assert.equal(await readFile(sentinelPath, 'utf8'), 'unchanged\n');
  }

  const occupiedServer = createServer();
  await new Promise((resolveListen, rejectListen) => {
    occupiedServer.once('error', rejectListen);
    occupiedServer.listen(0, '127.0.0.1', resolveListen);
  });
  t.after(async () => {
    if (!occupiedServer.listening) return;
    await new Promise((resolveClose, rejectClose) => {
      occupiedServer.close((error) => (error ? rejectClose(error) : resolveClose()));
    });
  });
  const occupiedPort = occupiedServer.address().port;
  const occupiedWorkingDirectory = await createTemporaryDirectory(
    t,
    'superagent-occupied-port-',
  );
  const occupiedUrl = `http://127.0.0.1:${occupiedPort}`;
  const occupiedResult = runScript(startScript, {
    cwd: occupiedWorkingDirectory,
    env: {
      ...process.env,
      DEMO_PORT: String(occupiedPort),
      DEMO_RUNTIME_DIR: join(occupiedWorkingDirectory, 'runtime'),
    },
    timeout: 5_000,
  });

  assert.notEqual(occupiedResult.status, 0);
  assert.doesNotMatch(occupiedResult.stdout, new RegExp(occupiedUrl.replaceAll('.', '\\.')));
});

test('start rejects a whitespace runtime without changing a sentinel', async (t) => {
  const workingDirectory = await createTemporaryDirectory(t, 'superagent-empty-runtime-');
  const sentinelPath = join(workingDirectory, 'sentinel.txt');
  await writeFile(sentinelPath, 'unchanged\n', 'utf8');
  const result = runScript(startScript, {
    cwd: workingDirectory,
    env: {
      ...process.env,
      DEMO_PORT: '4173',
      DEMO_RUNTIME_DIR: ' \t ',
    },
    timeout: 5_000,
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DEMO_RUNTIME_DIR/);
  assert.deepEqual(await readdir(workingDirectory), ['sentinel.txt']);
  assert.equal(await readFile(sentinelPath, 'utf8'), 'unchanged\n');
});

test('manual documents operation, evidence, boundaries, and live upgrade order', async () => {
  const source = await readFile(join(demoDirectory, 'README.md'), 'utf8');
  for (const heading of [
    '30 秒启动',
    '7 分钟演示脚本',
    '命令与环境变量',
    '生成的真实产物',
    '真实与模拟的边界',
    '架构与数据流',
    'API 与 curl',
    '停止、重置与清理',
    '故障排查',
    '安全边界',
    '验收',
    '升级到真实 GitHub / DSH',
  ]) {
    assert.match(source, new RegExp(`^## ${heading}`, 'm'), heading);
  }
  for (const requiredText of [
    'http://127.0.0.1:4173',
    'DEMO_PORT',
    'DEMO_RUNTIME_DIR',
    'demo/.runtime/state.json',
    'demo/.runtime/repo',
    'agent/demo-discount-boundary',
    'fix: support 100 percent discounts',
    'fix: reject non-finite discount inputs',
    'explicit-only',
    'maxWorkers: 1',
    'manual merge',
    '82632b66f5914e9946edce300e10633a3d5c0cb7',
    'dsh',
    'gh-auth',
    '../docs/003-execution.md',
    '../docs/006-deployment.md',
  ]) {
    assert.match(source, new RegExp(requiredText.replaceAll('/', '\\/')));
  }
  assert.match(source, /研究原型/);
  assert.match(source, /非 production/i);
  assert.match(source, /不会自动 (?:clone|push)/i);
  assert.match(source, /repo=\/absolute\/path\/to\/dsh-superagent/);
  assert.match(source, /"\$repo\/demo\/verify\.sh"/);
  assert.match(source, /"\$repo\/demo\/start\.sh"/);
  assert.doesNotMatch(source, /^demo\/(?:verify|start)\.sh$/m);
  assert.match(source, /canonical_repo=\$\(CDPATH= cd -P "\$repo"/);
  assert.match(source, /canonical_demo=\$\(CDPATH= cd -P "\$canonical_repo\/demo"/);
  assert.match(source, /canonical_runtime=\$\(CDPATH= cd -P "\$runtime"/);
  assert.match(source, /"\$canonical_repo\/demo\/\.runtime"/);
  assert.doesNotMatch(source, /repo=\$\(git rev-parse --show-toplevel\)/);
  assert.doesNotMatch(source, /\[ "\$runtime" = "\$repo\/demo\/\.runtime" \]/);
});

test('documented cleanup removes only the exact canonical runtime', async (t) => {
  const source = await readFile(join(demoDirectory, 'README.md'), 'utf8');
  const cleanupSnippet = extractCleanupSnippet(source);
  const workingDirectory = await createTemporaryDirectory(t, 'superagent-cleanup-');
  const repositoryPath = join(workingDirectory, 'repo with spaces');
  const demoPath = join(repositoryPath, 'demo');
  const runtimePath = join(demoPath, '.runtime');
  const demoSentinel = join(demoPath, 'keep.txt');
  const externalSentinel = join(workingDirectory, 'external.txt');
  await mkdir(runtimePath, { recursive: true });
  await Promise.all([
    writeFile(join(runtimePath, 'state.json'), '{}\n', 'utf8'),
    writeFile(demoSentinel, 'keep demo\n', 'utf8'),
    writeFile(externalSentinel, 'keep external\n', 'utf8'),
  ]);

  const cleanupResult = spawnSync(
    '/bin/sh',
    ['-c', withCleanupRepository(cleanupSnippet, repositoryPath)],
    { cwd: workingDirectory, encoding: 'utf8' },
  );
  assert.equal(cleanupResult.status, 0, cleanupResult.stderr);
  await assert.rejects(stat(runtimePath), { code: 'ENOENT' });
  assert.equal(await readFile(demoSentinel, 'utf8'), 'keep demo\n');
  assert.equal(await readFile(externalSentinel, 'utf8'), 'keep external\n');

  const externalRuntime = join(workingDirectory, 'external-runtime');
  const linkedSentinel = join(externalRuntime, 'keep-linked.txt');
  await mkdir(externalRuntime);
  await writeFile(linkedSentinel, 'keep linked\n', 'utf8');
  await symlink(externalRuntime, runtimePath);
  const symlinkResult = spawnSync(
    '/bin/sh',
    ['-c', withCleanupRepository(cleanupSnippet, repositoryPath)],
    { cwd: workingDirectory, encoding: 'utf8' },
  );
  assert.notEqual(symlinkResult.status, 0);
  assert.match(symlinkResult.stderr, /拒绝：runtime/);
  assert.equal(await readFile(linkedSentinel, 'utf8'), 'keep linked\n');

  await rm(runtimePath);
  await mkdir(runtimePath);
  const runtimeSentinel = join(runtimePath, 'keep-runtime.txt');
  await writeFile(runtimeSentinel, 'keep runtime\n', 'utf8');
  const repositoryAlias = join(workingDirectory, 'repo-alias');
  await symlink(repositoryPath, repositoryAlias);
  const noncanonicalResult = spawnSync(
    '/bin/sh',
    ['-c', withCleanupRepository(cleanupSnippet, repositoryAlias)],
    { cwd: workingDirectory, encoding: 'utf8' },
  );
  assert.notEqual(noncanonicalResult.status, 0);
  assert.match(noncanonicalResult.stderr, /拒绝：repo 不是 canonical path/);
  assert.equal(await readFile(runtimeSentinel, 'utf8'), 'keep runtime\n');
});

test('git ignores only the demo runtime artifact required by the launcher', async () => {
  const ignoreLines = (await readFile(join(repositoryDirectory, '.gitignore'), 'utf8'))
    .split(/\r?\n/)
    .filter(Boolean);
  assert.ok(ignoreLines.includes('demo/.runtime/'));
  assert.equal(ignoreLines.filter((line) => line.startsWith('demo/')).length, 1);
});
