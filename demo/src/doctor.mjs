import { runProcess } from './process.mjs';

const MINIMUM_NODE_VERSION = Object.freeze([22, 0, 0]);
const MINIMUM_GH_VERSION = Object.freeze([2, 48, 0]);
const PROBE_TIMEOUT_MS = 2_500;
const PROBE_MAX_OUTPUT_BYTES = 16 * 1024;

function createCheck(id, status, label, detail) {
  return Object.freeze({ id, status, label, detail });
}

function parseVersion(value) {
  if (typeof value !== 'string') return undefined;
  const match = value.match(/(?:^|[^\d])(\d+)\.(\d+)\.(\d+)(?:[^\d]|$)/);
  if (!match) return undefined;
  return Object.freeze(match.slice(1).map(Number));
}

function formatVersion(version) {
  return version.join('.');
}

function isAtLeast(version, minimum) {
  return minimum.every((minimumPart, index) => {
    const precedingPartsMatch = minimum
      .slice(0, index)
      .every((part, precedingIndex) => version[precedingIndex] === part);
    return !precedingPartsMatch || version[index] >= minimumPart;
  });
}

function isMissingCommand(error) {
  return error?.code === 'ENOENT' || error?.cause?.code === 'ENOENT';
}

async function safelyProbe(probe, command, args, cwd) {
  try {
    const result = await probe(command, args, {
      cwd,
      shell: false,
      timeoutMs: PROBE_TIMEOUT_MS,
      maxOutputBytes: PROBE_MAX_OUTPUT_BYTES,
      rejectOnNonZero: false,
    });
    return Object.freeze({ kind: 'result', result });
  } catch (error) {
    return Object.freeze({
      kind: 'error',
      missing: isMissingCommand(error),
    });
  }
}

function isSuccessful(probeResult) {
  return (
    probeResult.kind === 'result' &&
    probeResult.result?.code === 0 &&
    probeResult.result?.timedOut !== true
  );
}

function failureDetail(probeResult, name) {
  if (probeResult.kind === 'error') {
    return probeResult.missing
      ? `${name} is not installed or is not on PATH.`
      : `${name} could not be checked.`;
  }
  if (probeResult.result?.timedOut === true) {
    return `${name} check timed out.`;
  }
  return `${name} is unavailable.`;
}

function checkNode(nodeVersion) {
  const version = parseVersion(nodeVersion);
  if (!version || !isAtLeast(version, MINIMUM_NODE_VERSION)) {
    return createCheck(
      'node',
      'blocked',
      'Node.js runtime',
      'Live mode requires Node.js 22 or newer.',
    );
  }
  return createCheck(
    'node',
    'ready',
    'Node.js runtime',
    `Node.js ${formatVersion(version)} is supported.`,
  );
}

function checkGit(probeResult) {
  if (!isSuccessful(probeResult)) {
    return createCheck(
      'git',
      'blocked',
      'Git CLI',
      failureDetail(probeResult, 'Git'),
    );
  }
  const version = parseVersion(probeResult.result.stdout);
  return createCheck(
    'git',
    'ready',
    'Git CLI',
    version
      ? `Git ${formatVersion(version)} is available.`
      : 'Git is available.',
  );
}

function checkGh(probeResult) {
  if (!isSuccessful(probeResult)) {
    return createCheck(
      'gh',
      'blocked',
      'GitHub CLI',
      failureDetail(probeResult, 'GitHub CLI'),
    );
  }
  const version = parseVersion(probeResult.result.stdout);
  if (!version) {
    return createCheck(
      'gh',
      'blocked',
      'GitHub CLI',
      'GitHub CLI version could not be determined.',
    );
  }
  if (!isAtLeast(version, MINIMUM_GH_VERSION)) {
    return createCheck(
      'gh',
      'blocked',
      'GitHub CLI',
      'Live mode requires GitHub CLI 2.48 or newer.',
    );
  }
  return createCheck(
    'gh',
    'ready',
    'GitHub CLI',
    `GitHub CLI ${formatVersion(version)} is supported.`,
  );
}

function checkGhAuthentication(probeResult) {
  if (!isSuccessful(probeResult)) {
    const detail = probeResult.kind === 'result' && probeResult.result?.timedOut !== true
      ? 'GitHub CLI is not authenticated.'
      : failureDetail(probeResult, 'GitHub authentication');
    return createCheck(
      'gh-auth',
      'blocked',
      'GitHub authentication',
      detail,
    );
  }
  return createCheck(
    'gh-auth',
    'ready',
    'GitHub authentication',
    'GitHub CLI authentication is available.',
  );
}

function checkDsh(probeResult) {
  if (!isSuccessful(probeResult)) {
    return createCheck(
      'dsh',
      'blocked',
      'DeepSeek Harness CLI',
      failureDetail(probeResult, 'DeepSeek Harness CLI'),
    );
  }
  return createCheck(
    'dsh',
    'ready',
    'DeepSeek Harness CLI',
    'DeepSeek Harness CLI is available.',
  );
}

function checkSource(probeResult) {
  const firstOutputLine = probeResult.kind === 'result'
    ? String(probeResult.result?.stdout ?? '').split(/\r?\n/, 1)[0].trim()
    : '';
  if (!isSuccessful(probeResult) || firstOutputLine !== 'true') {
    const detail = probeResult.kind === 'result' && probeResult.result?.timedOut === true
      ? 'Source checkout check timed out.'
      : probeResult.kind === 'error'
        ? failureDetail(probeResult, 'Source checkout')
        : 'The source directory is not a Git work tree.';
    return createCheck(
      'source',
      'blocked',
      'Project source checkout',
      detail,
    );
  }
  return createCheck(
    'source',
    'ready',
    'Project source checkout',
    'The source directory is a Git work tree.',
  );
}

function optionalChecks(buildInfo, profileName) {
  return Object.freeze([
    ...(buildInfo === undefined || buildInfo === null
      ? []
      : [
          createCheck(
            'build',
            'info',
            'Project build',
            'Build information is available for this checkout.',
          ),
        ]),
    ...(profileName === undefined || profileName === null
      ? []
      : [
          createCheck(
            'profile',
            'info',
            'DeepSeek Harness profile',
            'Profile information was supplied for live mode.',
          ),
        ]),
  ]);
}

/**
 * Runs read-only local probes for the optional GitHub/DSH live mode.
 * Command output is parsed only for versions and is never returned.
 */
export async function checkLiveReadiness(options = {}) {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('options must be an object');
  }
  const cwd = options.cwd ?? process.cwd();
  const probe = options.probe ?? options.commandProbe ?? runProcess;
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  if (typeof cwd !== 'string' || cwd.length === 0) {
    throw new TypeError('cwd must be a non-empty path');
  }
  if (typeof probe !== 'function') {
    throw new TypeError('probe must be a function');
  }

  const [gitResult, ghResult, ghAuthResult, dshResult, sourceResult] =
    await Promise.all([
      safelyProbe(probe, 'git', ['--version'], cwd),
      safelyProbe(probe, 'gh', ['--version'], cwd),
      safelyProbe(probe, 'gh', ['auth', 'status'], cwd),
      safelyProbe(probe, 'dsh', ['--version'], cwd),
      safelyProbe(
        probe,
        'git',
        ['rev-parse', '--is-inside-work-tree'],
        cwd,
      ),
    ]);

  const checks = Object.freeze([
    checkNode(nodeVersion),
    checkGit(gitResult),
    checkGh(ghResult),
    checkGhAuthentication(ghAuthResult),
    checkDsh(dshResult),
    checkSource(sourceResult),
    ...optionalChecks(options.buildInfo, options.profileName),
  ]);
  const blockers = Object.freeze(
    checks.filter(({ status }) => status === 'blocked'),
  );
  return Object.freeze({
    ready: blockers.length === 0,
    checks,
    blockers,
  });
}
