import { lstat, readdir } from 'node:fs/promises';
import { parse, relative, resolve, sep } from 'node:path';

export const ASSIGNMENT_BRANCH = 'agent/demo-discount-boundary';

export class GitRecoveryError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'GitRecoveryError';
  }
}

export async function assertTreeHasNoSymbolicLinks(treePath) {
  const metadata = await lstat(treePath);
  if (metadata.isSymbolicLink()) {
    throw new GitRecoveryError(`Symbolic link is not allowed: ${treePath}`);
  }
  if (!metadata.isDirectory()) return;
  const entries = await readdir(treePath);
  await Promise.all(entries.map((entry) =>
    assertTreeHasNoSymbolicLinks(resolve(treePath, entry))));
}

export async function assertTrustedDirectoryPath(directoryPath) {
  const { root } = parse(directoryPath);
  const components = relative(root, directoryPath).split(sep).filter(Boolean);
  let currentPath = root;
  for (const component of components) {
    currentPath = resolve(currentPath, component);
    const metadata = await lstat(currentPath);
    if (metadata.isSymbolicLink()) {
      throw new GitRecoveryError('Repository parent contains a symbolic link');
    }
    if (!metadata.isDirectory()) {
      throw new GitRecoveryError('Repository parent must contain only directories');
    }
  }
}

const COMMIT_HASH = /^[0-9a-f]{40}$/i;

export function validateRecoveryCommits(options) {
  if (!options || typeof options !== 'object' || !Array.isArray(options.commits)) {
    throw new GitRecoveryError('resume requires a commits array');
  }
  if (options.commits.length > 2) {
    throw new GitRecoveryError('resume accepts at most two persisted commits');
  }
  const hashes = options.commits.map((commit) => {
    const hash = commit?.hash;
    if (typeof hash !== 'string' || !COMMIT_HASH.test(hash)) {
      throw new GitRecoveryError('Persisted commit hash must be a full hexadecimal object ID');
    }
    return hash.toLowerCase();
  });
  if (new Set(hashes).size !== hashes.length) {
    throw new GitRecoveryError('Persisted commit hashes must be distinct');
  }
  return Object.freeze(hashes);
}

function parseLinearHistory(output) {
  const history = output.trim().split('\n').filter(Boolean).map((line) => {
    const [hash, ...parents] = line.trim().split(/\s+/);
    return { hash, parents };
  });
  if (history.length === 0 || history[0].parents.length !== 0) {
    throw new GitRecoveryError('Runtime repository must contain one root commit');
  }
  for (let index = 1; index < history.length; index += 1) {
    const expectedParent = history[index - 1].hash;
    if (history[index].parents.length !== 1 || history[index].parents[0] !== expectedParent) {
      throw new GitRecoveryError('Runtime repository history must be one linear chain');
    }
  }
  return history;
}

function assertPersistedPrefix(history, hashes) {
  for (const [index, hash] of hashes.entries()) {
    if (history[index + 1]?.hash !== hash) {
      throw new GitRecoveryError('Persisted commits are not the expected history after the root');
    }
  }
}

export async function restoreGitRepository({ git, hashes }) {
  const historyResult = await git([
    'rev-list', '--reverse', '--topo-order', '--parents', '--all',
  ]);
  const history = parseLinearHistory(historyResult.stdout);
  assertPersistedPrefix(history, hashes);
  const rootCommit = history[0].hash;
  const targetCommit = hashes.at(-1) ?? rootCommit;
  const branch = hashes.length === 0 ? 'main' : ASSIGNMENT_BRANCH;

  await git(['reset', '--hard']);
  await git(['clean', '-ffdx']);
  await git(['checkout', '--force', '-B', branch, targetCommit]);
  await git(['update-ref', 'refs/heads/main', rootCommit]);
  if (hashes.length === 0) {
    await git(['update-ref', '-d', `refs/heads/${ASSIGNMENT_BRANCH}`]);
  }
  await git(['reset', '--hard', targetCommit]);
  await git(['clean', '-ffdx']);

  const [headResult, branchResult, statusResult, mainResult] = await Promise.all([
    git(['rev-parse', 'HEAD']),
    git(['branch', '--show-current']),
    git(['status', '--short']),
    git(['rev-parse', 'refs/heads/main']),
  ]);
  if (
    headResult.stdout.trim() !== targetCommit ||
    branchResult.stdout.trim() !== branch ||
    statusResult.stdout !== '' ||
    mainResult.stdout.trim() !== rootCommit
  ) {
    throw new GitRecoveryError('Runtime repository did not reach the persisted milestone');
  }
  return Object.freeze({
    branch,
    initialCommit: rootCommit,
    stage: ['ready', 'initial-complete', 'complete'][hashes.length],
  });
}
