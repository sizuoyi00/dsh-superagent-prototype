import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

import { createState } from '../src/domain.mjs';
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

async function createHarness(t, options = {}) {
  const rootDirectory = await mkdtemp(join(tmpdir(), 'superagent-ui-'));
  const server = createDemoServer({
    runtimeDir: join(rootDirectory, 'runtime'),
    publicDir: publicDirectory,
    fixtureDir: fixtureDirectory,
    doctor: options.doctor ?? (async () => ({
      ready: false,
      checks: [
        { id: 'git', status: 'ready', label: 'Git CLI', detail: 'Git is ready.' },
        { id: 'dsh', status: 'blocked', label: 'DSH CLI', detail: 'DSH is not installed.' },
      ],
      blockers: ['DSH CLI is required for production mode.'],
    })),
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

async function loadDom(baseUrl, apiFetch = globalThis.fetch) {
  const nodeFetch = globalThis.fetch;
  return JSDOM.fromURL(`${baseUrl}/`, {
    resources: 'usable',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = (input, options) => {
        const url = new URL(input, window.location.href);
        return url.pathname.startsWith('/api/')
          ? apiFetch(url, options)
          : nodeFetch(url, options);
      };
    },
  });
}

async function postJson(baseUrl, pathname) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(response.status, 200, pathname);
  return response.json();
}

async function waitFor(predicate, label, timeoutMs = 5_000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
}

function jsonResponse(value, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  }));
}

test('serves a semantic Chinese control room with every operator region', async (t) => {
  const baseUrl = await createHarness(t);
  const response = await fetch(`${baseUrl}/`);
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(html, /<html[^>]+lang="zh-CN"/i);
  assert.match(html, /<title>[^<]*SuperAgent[^<]*<\/title>/i);
  assert.match(html, /<meta[^>]+name="viewport"[^>]+width=device-width/i);
  assert.match(html, /<link[^>]+rel="icon"[^>]+href="\/favicon\.svg"/i);
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
  assert.match(html, /id="worker-slot">0 \/ 1</i);
  assert.match(html, /id="ticket-session"/i);
  assert.match(html, /id="ticket-branch"/i);
  assert.match(html, /id="ticket-commits"/i);
  assert.match(html, /id="ticket-tests"/i);
  assert.match(html, /<section[^>]+id="timeline"/i);
  assert.match(html, /<ol[^>]+id="timeline-list"[^>]+tabindex="0"/i);
  assert.match(html, /<ol[^>]+id="timeline-list"[^>]+role="region"/i);
  assert.match(html, /<ol[^>]+id="timeline-list"[^>]+aria-label="[^"]*滚动/i);
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

test('keeps guided state usable when the doctor endpoint fails', async (t) => {
  const baseUrl = await createHarness(t, {
    doctor: async () => {
      throw new Error('probe unavailable');
    },
  });
  const dom = await loadDom(baseUrl);
  try {
    const document = dom.window.document;
    await waitFor(
      () => document.querySelector('main').getAttribute('aria-busy') === 'false',
      'initial refresh to settle',
    );
    assert.equal(document.querySelector('#current-phase').textContent, 'READY / INTAKE');
    assert.equal(document.querySelector('#guided-action-button').disabled, false);
    assert.match(document.querySelector('#guided-action-button').textContent, /初始化本地实战仓库/);
    assert.equal(document.querySelector('#doctor-status').textContent, 'UNAVAILABLE');
    assert.match(document.querySelector('#doctor-blockers').textContent, /INTERNAL_ERROR/);
  } finally {
    dom.window.close();
  }
});

test('polls one running assignment until review and then stops', async (t) => {
  const baseUrl = await createHarness(t);
  const baseState = {
    ...createState(),
    repository: { initialCommit: 'a'.repeat(40) },
  };
  const runningAssignment = {
    id: 'assignment-1',
    status: 'running',
    branch: 'agent/demo-discount-boundary',
    sessionId: 'session-1',
  };
  const runningTicket = {
    id: 'ticket-1',
    status: 'running',
    branch: runningAssignment.branch,
    sessionId: runningAssignment.sessionId,
    commits: [],
  };
  const runningState = {
    ...baseState,
    phase: 'running',
    tickets: [runningTicket],
    assignments: [runningAssignment],
  };
  const reviewState = {
    ...runningState,
    phase: 'awaiting_review',
    tickets: [{
      ...runningTicket,
      status: 'awaiting_review',
      commits: [{ hash: 'b'.repeat(40), message: 'fix boundary' }],
    }],
    assignments: [{
      ...runningAssignment,
      status: 'completed',
      result: {
        tests: { ok: true, command: 'node --test' },
        patch: 'diff --git a/test b/test',
        files: ['test'],
      },
    }],
  };
  let stateRequests = 0;
  const apiFetch = (url) => {
    if (url.pathname === '/api/state') {
      stateRequests += 1;
      return jsonResponse(stateRequests === 1 ? runningState : reviewState);
    }
    if (url.pathname === '/api/doctor') {
      return jsonResponse({ ready: true, checks: [], blockers: [] });
    }
    return jsonResponse({ error: 'Unexpected route', code: 'TEST_ROUTE' }, 500);
  };
  const dom = await loadDom(baseUrl, apiFetch);
  try {
    const document = dom.window.document;
    const phase = document.querySelector('#current-phase');
    await waitFor(() => phase.textContent === 'RUNNING / WORKER', 'running phase');
    const runningMessage = document.querySelector('#action-description').textContent;
    await waitFor(
      () => phase.textContent === 'AWAITING / REVIEW',
      'automatic review refresh',
      1_750,
    );
    assert.match(runningMessage, /Worker 执行中，自动刷新/);
    assert.equal(stateRequests, 2);
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_100));
    assert.equal(stateRequests, 2);
  } finally {
    dom.window.close();
  }
});

test('does not restart polling after pagehide during an in-flight refresh', async (t) => {
  const baseUrl = await createHarness(t);
  const runningState = {
    ...createState(),
    phase: 'running',
    repository: { initialCommit: 'a'.repeat(40) },
    tickets: [{
      id: 'ticket-1',
      status: 'running',
      branch: 'agent/demo-discount-boundary',
      sessionId: 'session-1',
      commits: [],
    }],
    assignments: [{ id: 'assignment-1', status: 'running' }],
  };
  let stateRequests = 0;
  let releaseInFlightRequest;
  const apiFetch = (url) => {
    if (url.pathname === '/api/doctor') {
      return jsonResponse({ ready: true, checks: [], blockers: [] });
    }
    stateRequests += 1;
    if (stateRequests !== 2) return jsonResponse(runningState);
    return new Promise((resolveRequest) => {
      releaseInFlightRequest = () => resolveRequest(jsonResponse(runningState));
    });
  };
  const dom = await loadDom(baseUrl, apiFetch);
  try {
    await waitFor(() => stateRequests === 2, 'in-flight state poll', 1_750);
    dom.window.dispatchEvent(new dom.window.Event('pagehide'));
    releaseInFlightRequest();
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_100));
    assert.equal(stateRequests, 2);
  } finally {
    dom.window.close();
  }
});

test('renders the latest failure instead of historical successful evidence', async (t) => {
  const baseUrl = await createHarness(t);
  const failureSummary = 'The latest worker assignment failed safely';
  const failedState = {
    ...createState(),
    phase: 'failed',
    repository: { initialCommit: 'a'.repeat(40) },
    tickets: [{
      id: 'ticket-1',
      status: 'failed',
      branch: 'agent/demo-discount-boundary',
      sessionId: 'session-1',
      commits: [{ hash: 'b'.repeat(40), message: 'older success' }],
    }],
    assignments: [
      {
        id: 'assignment-1',
        status: 'completed',
        result: {
          tests: { ok: true, command: 'node --test' },
          patch: 'old-success-patch',
          files: ['src/discount.mjs'],
        },
      },
      {
        id: 'assignment-2',
        status: 'failed',
        error: { code: 'ASSIGNMENT_FAILED', message: failureSummary },
      },
    ],
    reports: [{
      id: 'report-1',
      state: 'failed',
      visible: true,
      summary: failureSummary,
    }],
  };
  const apiFetch = (url) => url.pathname === '/api/state'
    ? jsonResponse(failedState)
    : jsonResponse({ ready: true, checks: [], blockers: [] });
  const dom = await loadDom(baseUrl, apiFetch);
  try {
    const document = dom.window.document;
    await waitFor(
      () => document.querySelector('#current-phase').textContent === 'FAILED / VISIBLE',
      'failed state rendering',
    );
    const testEvidence = document.querySelector('#ticket-tests');
    assert.equal(testEvidence.dataset.status, 'failed');
    assert.match(testEvidence.textContent, /FAIL/);
    assert.match(testEvidence.textContent, new RegExp(failureSummary));
    assert.match(document.querySelector('#patch-meta').textContent, /FAILED/);
    assert.doesNotMatch(document.querySelector('#patch-output').textContent, /old-success-patch/);
    assert.match(document.querySelector('#patch-output').textContent, /上一版本/);
  } finally {
    dom.window.close();
  }
});

test('keeps worker capacity at one slot after two sequential assignments', async (t) => {
  const baseUrl = await createHarness(t);
  await postJson(baseUrl, '/api/reset');
  await postJson(baseUrl, '/api/issue');
  await postJson(baseUrl, '/api/run');
  await postJson(baseUrl, '/api/follow-up');
  const state = await postJson(baseUrl, '/api/run');
  assert.equal(state.assignments.length, 2);

  const dom = await loadDom(baseUrl);
  try {
    const phase = dom.window.document.querySelector('#current-phase');
    const workerSlot = dom.window.document.querySelector('#worker-slot');
    await waitFor(
      () => phase.textContent === 'AWAITING / REVIEW',
      'the rendered review phase',
    );
    assert.equal(workerSlot.textContent, '1 / 1');
  } finally {
    dom.window.close();
  }
});

test('serves all UI assets with strict content types and security headers', async (t) => {
  const baseUrl = await createHarness(t);
  const assets = [
    ['/', /^text\/html; charset=utf-8$/],
    ['/app.js', /^text\/javascript; charset=utf-8$/],
    ['/styles.css', /^text\/css; charset=utf-8$/],
    ['/favicon.svg', /^image\/svg\+xml; charset=utf-8$/],
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
  assert.match(script, /visibilitychange/);
  assert.match(script, /pagehide/);
  assert.match(script, /setTimeout/);
  assert.match(script, /clearTimeout/);
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
  assert.match(css, /\.timeline-list:focus-visible\s*{/);
  assert.match(css, /\.pipeline__index\s*{[^}]*color:\s*var\(--color-text-soft\)/is);
  assert.match(css, /min-height\s*:\s*(?:44px|2\.75rem)/);
  assert.match(css, /overflow-x\s*:\s*hidden/);
  assert.match(css, /\.patch-scroll[^}]*overflow(?:-x)?\s*:\s*auto/is);
  assert.doesNotMatch(css, /#[a-f\d]{3,8}[^\n]*(?:purple|violet)|purple|violet/i);
});
