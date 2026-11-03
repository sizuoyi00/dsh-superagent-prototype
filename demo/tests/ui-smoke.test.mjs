import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createDemoServer } from '../src/server.mjs';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const publicDirectory = resolve(testDirectory, '../public');
const fixtureDirectory = resolve(testDirectory, '../fixture');
const securityHeaders = {
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
};

async function createHarness(t) {
  const rootDirectory = await mkdtemp(join(tmpdir(), 'superagent-ui-'));
  const server = createDemoServer({
    runtimeDir: join(rootDirectory, 'runtime'),
    publicDir: publicDirectory,
    fixtureDir: fixtureDirectory,
    doctor: async () => ({
      ready: false,
      checks: [
        { id: 'git', status: 'ready', label: 'Git CLI', detail: 'Git is ready.' },
        { id: 'dsh', status: 'blocked', label: 'DSH CLI', detail: 'DSH is not installed.' },
      ],
      blockers: ['DSH CLI is required for production mode.'],
    }),
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  t.after(async () => {
    if (server.listening) {
      await new Promise((resolveClose, rejectClose) => {
        server.close((error) => (error ? rejectClose(error) : resolveClose()));
      });
    }
    await rm(rootDirectory, { recursive: true, force: true });
  });
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

test('serves a semantic Chinese control room with every operator region', async (t) => {
  const baseUrl = await createHarness(t);
  const response = await fetch(`${baseUrl}/`);
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(html, /<html[^>]+lang="zh-CN"/i);
  assert.match(html, /<title>[^<]*SuperAgent[^<]*<\/title>/i);
  assert.match(html, /<meta[^>]+name="viewport"[^>]+width=device-width/i);
  assert.match(html, /本地实战模式，不是真实 GitHub\/DSH/);
  assert.match(html, /真实 Git branch、test、commit、patch/);
  assert.match(html, /<header\b/i);
  assert.match(html, /<main\b/i);
  assert.match(html, /<section[^>]+id="guided-action"/i);
  assert.match(html, /id="guided-action-button"/i);
  assert.match(html, /id="current-phase"/i);
  assert.match(html, /<section[^>]+id="lifecycle"/i);
  for (const stage of ['Issue', 'Trigger', 'Eval', 'Ticket', 'Worker', 'PR / Review', 'Merge']) {
    assert.match(html, new RegExp(`>${stage.replace('/', '\\/')}<`, 'i'));
  }
  assert.match(html, /<section[^>]+id="ticket"/i);
  assert.match(html, /Ticket/);
  assert.match(html, /id="worker-slot"/i);
  assert.match(html, /id="ticket-session"/i);
  assert.match(html, /id="ticket-branch"/i);
  assert.match(html, /id="ticket-commits"/i);
  assert.match(html, /id="ticket-tests"/i);
  assert.match(html, /<section[^>]+id="timeline"/i);
  assert.match(html, /<section[^>]+id="patch"/i);
  assert.match(html, /<pre[^>]+id="patch-output"/i);
  assert.match(html, /<section[^>]+id="boundary"/i);
  assert.match(html, /本地真实发生/);
  assert.match(html, /生产模式替换/);
  assert.match(html, /<section[^>]+id="doctor"/i);
  assert.match(html, /id="doctor-blockers"/i);
  assert.match(html, /id="reset-button"/i);
  assert.match(html, /id="doctor-refresh-button"/i);
  assert.match(html, /(?:role="status"[^>]+aria-live="polite"|aria-live="polite"[^>]+role="status")/i);
  assert.match(html, /<script[^>]+src="\/app\.js"[^>]*><\/script>/i);
  assert.doesNotMatch(html, /<script(?![^>]+src=)[^>]*>/i);
  assert.doesNotMatch(html, /\sstyle="/i);
  assert.doesNotMatch(html, /https?:\/\//i);
});

test('serves all UI assets with strict content types and security headers', async (t) => {
  const baseUrl = await createHarness(t);
  const assets = [
    ['/', /^text\/html; charset=utf-8$/],
    ['/app.js', /^text\/javascript; charset=utf-8$/],
    ['/styles.css', /^text\/css; charset=utf-8$/],
  ];

  for (const [pathname, expectedType] of assets) {
    const response = await fetch(`${baseUrl}${pathname}`);
    assert.equal(response.status, 200, pathname);
    assert.match(response.headers.get('content-type') ?? '', expectedType, pathname);
    for (const [header, expected] of Object.entries(securityHeaders)) {
      assert.equal(response.headers.get(header), expected, `${pathname}: ${header}`);
    }
  }
});

test('browser controller encodes every guided phase without unsafe HTML sinks', async (t) => {
  const baseUrl = await createHarness(t);
  const response = await fetch(`${baseUrl}/app.js`);
  const script = await response.text();

  assert.equal(response.status, 200);
  assert.doesNotMatch(script, /\.innerHTML\b/);
  assert.doesNotMatch(script, /insertAdjacentHTML\b/);
  assert.doesNotMatch(script, /\beval\s*\(/);
  assert.doesNotMatch(script, /\bnew\s+Function\b/);
  assert.match(script, /\.textContent\b/);
  assert.match(script, /createElement\s*\(/);
  for (const route of [
    '/api/state', '/api/doctor', '/api/reset', '/api/issue',
    '/api/run', '/api/follow-up', '/api/recover', '/api/merge',
  ]) {
    assert.match(script, new RegExp(route.replaceAll('/', '\\/')));
  }
  for (const phase of ['ready', 'queued', 'awaiting_review', 'merged']) {
    assert.match(script, new RegExp(`['\"]${phase}['\"]`));
  }
  assert.match(script, /repository\?\.initialCommit|repository\.initialCommit/);
  assert.match(script, /commits\.length/);
  assert.match(script, /state\.recovered/);
  assert.match(script, /busy/);
  assert.match(script, /disabled/);
  assert.match(script, /error[^\n]+code|code[^\n]+error/i);
});

test('visual system defines industrial tokens and resilient responsive behavior', async (t) => {
  const baseUrl = await createHarness(t);
  const response = await fetch(`${baseUrl}/styles.css`);
  const css = await response.text();

  assert.equal(response.status, 200);
  assert.match(css, /:root\s*{/);
  assert.match(css, /--color-bg\s*:/);
  assert.match(css, /--color-signal-amber\s*:/);
  assert.match(css, /--color-signal-cyan\s*:/);
  assert.match(css, /font-family\s*:[^;]*(?:monospace|Mono)/i);
  assert.match(css, /@media\s*\([^)]*(?:max-width|min-width)[^)]*\)/i);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/i);
  assert.match(css, /:focus-visible/);
  assert.match(css, /min-height\s*:\s*(?:44px|2\.75rem)/);
  assert.match(css, /overflow-x\s*:\s*hidden/);
  assert.match(css, /\.patch-scroll[^}]*overflow(?:-x)?\s*:\s*auto/is);
  assert.doesNotMatch(css, /#[a-f\d]{3,8}[^\n]*(?:purple|violet)|purple|violet/i);
});
