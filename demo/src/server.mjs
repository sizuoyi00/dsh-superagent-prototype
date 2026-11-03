import {
  existsSync,
  realpathSync,
} from 'node:fs';
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  unlink,
} from 'node:fs/promises';
import { Server } from 'node:http';
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  completeAssignment,
  ConflictError,
  createState,
  failAssignment,
  mergeTicket,
  receiveFollowUp,
  receiveIssue,
  recoverState,
  startAssignment,
  ValidationError,
} from './domain.mjs';
import { checkLiveReadiness } from './doctor.mjs';
import { GitWorker } from './git-worker.mjs';
import { JsonStore } from './store.mjs';

const BODY_LIMIT_BYTES = 32 * 1024;
const SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
});
const STATIC_CONTENT_TYPES = Object.freeze({
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
});
const API_METHODS = Object.freeze(new Map([
  ['/api/state', 'GET'],
  ['/api/doctor', 'GET'],
  ['/api/reset', 'POST'],
  ['/api/issue', 'POST'],
  ['/api/run', 'POST'],
  ['/api/follow-up', 'POST'],
  ['/api/recover', 'POST'],
  ['/api/merge', 'POST'],
]));

class RequestError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'RequestError';
    this.status = status;
    this.code = code;
  }
}

class LoopbackServer extends Server {
  listen(...args) {
    const [target, possibleHost] = args;
    if (typeof target === 'number') {
      if (typeof possibleHost === 'string') {
        assertLoopbackBindHost(possibleHost);
        return super.listen(...args);
      }
      return super.listen(target, '127.0.0.1', ...args.slice(1));
    }
    if (target !== null && typeof target === 'object') {
      const host = target.host ?? '127.0.0.1';
      assertLoopbackBindHost(host);
      return super.listen({ ...target, host }, ...args.slice(1));
    }
    throw new TypeError('Demo server must listen on a loopback TCP port');
  }
}

function assertLoopbackBindHost(host) {
  if (
    typeof host !== 'string' ||
    !['127.0.0.1', 'localhost', '::1'].includes(host.toLowerCase())
  ) {
    throw new TypeError('Demo server may bind only to a loopback host');
  }
}

function isWithin(parentDirectory, candidatePath) {
  const pathFromParent = relative(parentDirectory, candidatePath);
  return (
    pathFromParent === '' ||
    (!pathFromParent.startsWith(`..${sep}`) &&
      pathFromParent !== '..' &&
      !isAbsolute(pathFromParent))
  );
}

function canonicalizeProspectivePath(directoryPath) {
  let existingPath = directoryPath;
  const missingComponents = [];

  while (!existsSync(existingPath)) {
    const parentPath = dirname(existingPath);
    if (parentPath === existingPath) break;
    missingComponents.unshift(basename(existingPath));
    existingPath = parentPath;
  }

  const canonicalParent = realpathSync(existingPath);
  return resolve(canonicalParent, ...missingComponents);
}

function validateDirectoryLayout(runtimeDir, publicDir, fixtureDir) {
  const namedPaths = [
    ['runtimeDir', runtimeDir],
    ['publicDir', publicDir],
    ['fixtureDir', fixtureDir],
  ].map(([name, value]) => {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new TypeError(`${name} must be a non-empty path`);
    }
    const resolvedPath = resolve(value);
    return Object.freeze({
      name,
      resolvedPath,
      canonicalPath: canonicalizeProspectivePath(resolvedPath),
    });
  });

  for (let leftIndex = 0; leftIndex < namedPaths.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < namedPaths.length;
      rightIndex += 1
    ) {
      const left = namedPaths[leftIndex];
      const right = namedPaths[rightIndex];
      const lexicalOverlap =
        isWithin(left.resolvedPath, right.resolvedPath) ||
        isWithin(right.resolvedPath, left.resolvedPath);
      const canonicalOverlap =
        isWithin(left.canonicalPath, right.canonicalPath) ||
        isWithin(right.canonicalPath, left.canonicalPath);
      if (lexicalOverlap || canonicalOverlap) {
        throw new TypeError(
          'runtimeDir, publicDir, and fixtureDir must be separate directory trees',
        );
      }
    }
  }

  return Object.freeze(Object.fromEntries(
    namedPaths.map(({ name, resolvedPath }) => [name, resolvedPath]),
  ));
}

function applySecurityHeaders(response) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    response.setHeader(name, value);
  }
}

function sendJson(response, status, value, extraHeaders = {}) {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    ...extraHeaders,
  });
  response.end(body);
}

function sendPlain(response, status, message, extraHeaders = {}) {
  const body = `${message}\n`;
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'text/plain; charset=utf-8',
    ...extraHeaders,
  });
  response.end(body);
}

function loopbackUrlFromHost(host) {
  if (typeof host !== 'string' || host.length === 0) return undefined;
  let url;
  try {
    url = new URL(`http://${host}`);
  } catch {
    return undefined;
  }
  const hostname = url.hostname.toLowerCase();
  if (!['localhost', '127.0.0.1', '[::1]'].includes(hostname)) {
    return undefined;
  }
  if (
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    return undefined;
  }
  return url;
}

function validateRequestAuthority(request) {
  const hostUrl = loopbackUrlFromHost(request.headers.host);
  if (!hostUrl) {
    throw new RequestError(403, 'INVALID_HOST', 'Request Host is not allowed');
  }

  const origin = request.headers.origin;
  if (origin === undefined) return;
  let originUrl;
  try {
    originUrl = new URL(origin);
  } catch {
    throw new RequestError(403, 'INVALID_ORIGIN', 'Request Origin is not allowed');
  }
  if (
    originUrl.protocol !== 'http:' ||
    originUrl.origin !== hostUrl.origin ||
    originUrl.username ||
    originUrl.password ||
    originUrl.pathname !== '/' ||
    originUrl.search ||
    originUrl.hash ||
    !loopbackUrlFromHost(originUrl.host)
  ) {
    throw new RequestError(403, 'INVALID_ORIGIN', 'Request Origin is not allowed');
  }
}

function decodeRequestPath(requestUrl) {
  const rawPath = String(requestUrl ?? '/').split('?', 1)[0] || '/';
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(rawPath);
  } catch {
    return undefined;
  }
  if (
    decodedPath.includes('\0') ||
    decodedPath.includes('\\') ||
    decodedPath.split('/').includes('..')
  ) {
    return undefined;
  }
  return decodedPath.startsWith('/') ? decodedPath : undefined;
}

function isApiPath(pathname) {
  return pathname === '/api' || pathname?.startsWith('/api/');
}

function isRawApiPath(requestUrl) {
  const rawPath = String(requestUrl ?? '/').split('?', 1)[0];
  return rawPath === '/api' || rawPath.startsWith('/api/');
}

async function readJsonBody(request) {
  const mediaType = request.headers['content-type']
    ?.split(';', 1)[0]
    .trim()
    .toLowerCase();
  if (mediaType !== 'application/json') {
    throw new RequestError(
      415,
      'UNSUPPORTED_MEDIA_TYPE',
      'Content-Type must be application/json',
    );
  }

  const declaredLength = Number(request.headers['content-length']);
  let byteLength = 0;
  let isTooLarge = Number.isFinite(declaredLength)
    && declaredLength > BODY_LIMIT_BYTES;
  const chunks = [];
  for await (const chunk of request) {
    byteLength += chunk.length;
    if (byteLength > BODY_LIMIT_BYTES) isTooLarge = true;
    if (!isTooLarge) chunks.push(chunk);
  }
  if (isTooLarge) {
    throw new RequestError(
      413,
      'BODY_TOO_LARGE',
      'Request body exceeds 32 KiB',
    );
  }

  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new RequestError(400, 'INVALID_JSON', 'Request body is not valid JSON');
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new RequestError(
      400,
      'VALIDATION_ERROR',
      'Request body must be a JSON object',
    );
  }
  return body;
}

function boundedString(body, field, options) {
  const value = body[field] ?? options.defaultValue;
  if (typeof value !== 'string') {
    throw new RequestError(
      400,
      'VALIDATION_ERROR',
      `${field} must be a string`,
    );
  }
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > options.maxLength) {
    throw new RequestError(
      400,
      'VALIDATION_ERROR',
      `${field} must contain 1-${options.maxLength} characters`,
    );
  }
  return normalized;
}

function validateIssueBody(body) {
  return Object.freeze({
    title: boundedString(body, 'title', {
      defaultValue: 'Fix the 100 percent discount boundary',
      maxLength: 160,
    }),
    requester: boundedString(body, 'requester', {
      defaultValue: 'demo-user',
      maxLength: 80,
    }),
    text: boundedString(body, 'text', {
      defaultValue: 'A 100 percent discount should produce a zero total.',
      maxLength: 4_000,
    }),
  });
}

function validateFollowUpBody(body) {
  return Object.freeze({
    requester: boundedString(body, 'requester', {
      defaultValue: 'demo-reviewer',
      maxLength: 80,
    }),
    text: boundedString(body, 'text', {
      defaultValue: 'Reject non-finite inputs and document the boundary.',
      maxLength: 4_000,
    }),
  });
}

async function serveStatic(request, response, publicDir, pathname) {
  if (!['GET', 'HEAD'].includes(request.method)) {
    sendPlain(response, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
    return;
  }
  if (!pathname) {
    sendPlain(response, 404, 'Not found');
    return;
  }

  let publicRoot;
  try {
    publicRoot = await realpath(publicDir);
  } catch {
    sendPlain(response, 404, 'Not found');
    return;
  }
  const relativeAssetPath = pathname === '/' ? 'index.html' : pathname.slice(1);
  const assetPath = resolve(publicRoot, relativeAssetPath);
  if (!isWithin(publicRoot, assetPath) || assetPath === publicRoot) {
    sendPlain(response, 404, 'Not found');
    return;
  }

  let realAssetPath;
  let metadata;
  try {
    realAssetPath = await realpath(assetPath);
    if (!isWithin(publicRoot, realAssetPath) || realAssetPath === publicRoot) {
      sendPlain(response, 404, 'Not found');
      return;
    }
    metadata = await stat(realAssetPath);
  } catch {
    sendPlain(response, 404, 'Not found');
    return;
  }
  if (!metadata.isFile()) {
    sendPlain(response, 404, 'Not found');
    return;
  }

  const content = await readFile(realAssetPath);
  response.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Length': String(content.length),
    'Content-Type':
      STATIC_CONTENT_TYPES[extname(realAssetPath).toLowerCase()] ??
      'application/octet-stream',
  });
  response.end(request.method === 'HEAD' ? undefined : content);
}

function sendRequestError(response, error) {
  if (error instanceof RequestError) {
    sendJson(response, error.status, { error: error.message, code: error.code });
    return;
  }
  if (error instanceof ConflictError) {
    sendJson(response, 409, { error: error.message, code: error.code });
    return;
  }
  if (error instanceof ValidationError) {
    sendJson(response, 400, { error: error.message, code: error.code });
    return;
  }
  sendJson(response, 500, {
    error: 'The demo server could not complete the request',
    code: 'INTERNAL_ERROR',
  });
}

export function createDemoServer({
  runtimeDir,
  publicDir,
  fixtureDir,
  doctor = checkLiveReadiness,
}) {
  if (typeof doctor !== 'function') {
    throw new TypeError('doctor must be a function');
  }
  const directories = validateDirectoryLayout(runtimeDir, publicDir, fixtureDir);
  const initialState = createState();
  const store = new JsonStore({
    filePath: join(directories.runtimeDir, 'state.json'),
    initialState,
  });
  const repoDir = join(directories.runtimeDir, 'repo');
  let currentState;
  let runInProgress = false;
  let worker;

  async function getState() {
    if (currentState === undefined) currentState = await store.load();
    return currentState;
  }

  async function saveState(nextState) {
    await store.save(nextState);
    currentState = nextState;
    return nextState;
  }

  async function prepareRuntimeRepository() {
    await mkdir(directories.runtimeDir, { recursive: true });
    const runtimeMetadata = await lstat(directories.runtimeDir);
    const realRuntimeDirectory = await realpath(directories.runtimeDir);
    if (
      runtimeMetadata.isSymbolicLink() ||
      !runtimeMetadata.isDirectory() ||
      realRuntimeDirectory !== directories.runtimeDir ||
      dirname(repoDir) !== directories.runtimeDir ||
      !isWithin(directories.runtimeDir, repoDir) ||
      repoDir === directories.runtimeDir
    ) {
      throw new RequestError(
        400,
        'UNSAFE_RUNTIME',
        'runtimeDir must be a real, isolated directory',
      );
    }

    try {
      const repositoryMetadata = await lstat(repoDir);
      if (repositoryMetadata.isSymbolicLink()) await unlink(repoDir);
      else await rm(repoDir, { recursive: true, force: true });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }

  async function resetDemo() {
    await prepareRuntimeRepository();
    const nextWorker = new GitWorker({
      fixtureDir: directories.fixtureDir,
      repoDir,
    });
    await nextWorker.initialize();
    const resetState = await saveState(createState());
    worker = nextWorker;
    return resetState;
  }

  async function receiveDemoIssue(body) {
    const issue = validateIssueBody(body);
    return saveState(receiveIssue(await getState(), {
      title: issue.title,
      author: issue.requester,
      body: issue.text,
    }));
  }

  async function executeDemoAssignment() {
    if (!worker) {
      throw new RequestError(
        409,
        'WORKER_NOT_READY',
        'Reset the demo before running an assignment',
      );
    }
    const runningState = await saveState(startAssignment(await getState()));
    const assignment = runningState.assignments.at(-1);
    const workerPhase = assignment.kind === 'initial' ? 'initial' : 'follow-up';
    let workerResult;
    try {
      workerResult = await worker.runAssignment(workerPhase);
    } catch {
      const publicFailure = Object.freeze({
        name: 'AssignmentError',
        message: 'The local worker could not complete the assignment',
        code: 'ASSIGNMENT_FAILED',
      });
      await saveState(failAssignment(runningState, publicFailure));
      throw new RequestError(500, publicFailure.code, publicFailure.message);
    }
    const existingHashes = new Set(
      runningState.tickets.at(-1).commits.map(({ hash }) => hash),
    );
    const incrementalResult = {
      ...workerResult,
      commits: workerResult.commits.filter(({ hash }) => !existingHashes.has(hash)),
    };
    return saveState(completeAssignment(runningState, incrementalResult));
  }

  async function runDemoAssignment() {
    if (runInProgress) {
      throw new RequestError(
        409,
        'RUN_IN_PROGRESS',
        'Another assignment is already running',
      );
    }
    runInProgress = true;
    try {
      return await executeDemoAssignment();
    } finally {
      runInProgress = false;
    }
  }

  async function receiveDemoFollowUp(body) {
    const followUp = validateFollowUpBody(body);
    return saveState(receiveFollowUp(await getState(), {
      author: followUp.requester,
      text: followUp.text,
    }));
  }

  async function recoverDemo() {
    const persistedState = await store.load();
    return saveState(recoverState(persistedState));
  }

  async function handleApi(request, response, pathname) {
    const allowedMethod = API_METHODS.get(pathname);
    if (!allowedMethod) {
      sendJson(response, 404, { error: 'Not found', code: 'NOT_FOUND' });
      return;
    }
    if (request.method !== allowedMethod) {
      sendJson(
        response,
        405,
        { error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' },
        { Allow: allowedMethod },
      );
      return;
    }
    if (request.method === 'GET') {
      if (pathname === '/api/state') {
        sendJson(response, 200, await getState());
        return;
      }
      sendJson(response, 200, await doctor());
      return;
    }

    const body = await readJsonBody(request);
    let result;
    switch (pathname) {
      case '/api/reset':
        result = await resetDemo();
        break;
      case '/api/issue':
        result = await receiveDemoIssue(body);
        break;
      case '/api/run':
        result = await runDemoAssignment();
        break;
      case '/api/follow-up':
        result = await receiveDemoFollowUp(body);
        break;
      case '/api/recover':
        result = await recoverDemo();
        break;
      case '/api/merge':
        result = await saveState(mergeTicket(await getState()));
        break;
      default:
        throw new RequestError(404, 'NOT_FOUND', 'Not found');
    }
    sendJson(response, 200, result);
  }

  return new LoopbackServer(async (request, response) => {
    applySecurityHeaders(response);
    try {
      validateRequestAuthority(request);
      const pathname = decodeRequestPath(request.url);
      if (isApiPath(pathname) || isRawApiPath(request.url)) {
        if (!pathname) {
          sendJson(response, 404, { error: 'Not found', code: 'NOT_FOUND' });
          return;
        }
        await handleApi(request, response, pathname);
        return;
      }
      await serveStatic(request, response, directories.publicDir, pathname);
    } catch (error) {
      if (!response.headersSent) sendRequestError(response, error);
      else response.destroy();
    }
  });
}

function parseDemoPort(value) {
  const port = Number(value ?? 4173);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new TypeError('DEMO_PORT must be an integer between 1 and 65535');
  }
  return port;
}

const modulePath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === modulePath) {
  const demoDirectory = resolve(dirname(modulePath), '..');
  const server = createDemoServer({
    runtimeDir: resolve(
      process.env.DEMO_RUNTIME_DIR ?? join(demoDirectory, '.runtime'),
    ),
    publicDir: resolve(demoDirectory, 'public'),
    fixtureDir: resolve(demoDirectory, 'fixture'),
  });
  const port = parseDemoPort(process.env.DEMO_PORT);
  server.listen(port, '127.0.0.1', () => {
    process.stdout.write(`SuperAgent demo: http://127.0.0.1:${port}\n`);
  });
}
