import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
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
      // The launcher prints before the server starts listening; retry briefly.
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
  assert.match(source, /--test/);
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
    },
  });

  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Fixture tests:\s+\d+ file/);
  assert.match(result.stdout, /Demo tests:\s+\d+ file/);
  assert.match(result.stdout, /Syntax checks:\s+\d+ file/);
  assert.match(result.stdout, /Verification complete:/);
  assert.deepEqual(await readdir(workingDirectory), []);
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

test('start rejects ports outside 1..65535 before creating runtime data', async (t) => {
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
});

test('git ignores only the demo runtime artifact required by the launcher', async () => {
  const ignoreLines = (await readFile(join(repositoryDirectory, '.gitignore'), 'utf8'))
    .split(/\r?\n/)
    .filter(Boolean);
  assert.ok(ignoreLines.includes('demo/.runtime/'));
  assert.equal(ignoreLines.filter((line) => line.startsWith('demo/')).length, 1);
});
