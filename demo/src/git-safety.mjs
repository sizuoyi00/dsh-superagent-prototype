import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

export const SAFE_GIT_CONFIG_ENTRIES = Object.freeze([
  Object.freeze(['commit.gpgSign', 'false']),
  Object.freeze(['tag.gpgSign', 'false']),
  Object.freeze(['core.fsmonitor', 'false']),
  Object.freeze(['core.hooksPath', '']),
]);

const GLOBAL_CONFIG = `[commit]
\tgpgSign = false
[tag]
\tgpgSign = false
[core]
\tfsmonitor = false
\thooksPath =
`;

const LOCAL_CONFIG = `[core]
\trepositoryformatversion = 0
\tfilemode = false
\tbare = false
\tlogallrefupdates = true
\tfsmonitor = false
\thooksPath =
[user]
\tname = SuperAgent Demo
\temail = superagent-demo@example.invalid
[commit]
\tgpgSign = false
[tag]
\tgpgSign = false
`;

class GitSafetyError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'GitSafetyError';
  }
}

function isWithin(parentDirectory, candidatePath) {
  const pathFromParent = relative(parentDirectory, candidatePath);
  return (
    pathFromParent === '' ||
    (!pathFromParent.startsWith('..') && !isAbsolute(pathFromParent))
  );
}

function identityPaths(repositoryDirectory) {
  const gitDirectory = resolve(repositoryDirectory, '.git');
  const controlDirectory = resolve(gitDirectory, 'superagent-control');
  return [
    { path: repositoryDirectory, kind: 'directory' },
    { path: gitDirectory, kind: 'directory' },
    { path: resolve(gitDirectory, 'config'), kind: 'file', seal: true },
    { path: controlDirectory, kind: 'directory' },
    { path: resolve(controlDirectory, 'home'), kind: 'directory' },
    { path: resolve(controlDirectory, 'xdg'), kind: 'directory' },
    {
      path: resolve(controlDirectory, 'hooks'),
      kind: 'directory',
      requireEmpty: true,
    },
    {
      path: resolve(controlDirectory, 'global.config'),
      kind: 'file',
      seal: true,
    },
  ];
}

function assertStableMetadata(before, after) {
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.nlink !== after.nlink
  ) {
    throw new GitSafetyError('Git safety identity changed during verification');
  }
}

async function captureIdentity(repositoryDirectory, specification) {
  const metadata = await lstat(specification.path);
  const hasExpectedKind =
    specification.kind === 'directory'
      ? metadata.isDirectory()
      : metadata.isFile();
  if (metadata.isSymbolicLink() || !hasExpectedKind) {
    throw new GitSafetyError('Git safety identity has an invalid type');
  }
  if (specification.kind === 'file' && metadata.nlink !== 1) {
    throw new GitSafetyError('Git safety control file must not be hard linked');
  }

  const canonicalPath = await realpath(specification.path);
  if (!isWithin(repositoryDirectory, canonicalPath)) {
    throw new GitSafetyError('Git safety identity escapes the repository');
  }
  if (specification.requireEmpty) {
    const entries = await readdir(specification.path);
    if (entries.length !== 0) {
      throw new GitSafetyError('Git safety hooks directory is not empty');
    }
  }

  let content;
  let sha256;
  if (specification.seal) {
    const bytes = await readFile(specification.path);
    content = bytes.toString('base64');
    sha256 = createHash('sha256').update(bytes).digest('hex');
  }
  const finalMetadata = await lstat(specification.path);
  assertStableMetadata(metadata, finalMetadata);

  return Object.freeze({
    path: specification.path,
    kind: specification.kind,
    canonicalPath,
    device: finalMetadata.dev,
    inode: finalMetadata.ino,
    linkCount: finalMetadata.nlink,
    content,
    sha256,
  });
}

export async function createGitControlDirectory(controlDirectory) {
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
  try {
    await configHandle.writeFile(GLOBAL_CONFIG, 'utf8');
    await configHandle.sync();
  } finally {
    await configHandle.close();
  }
}

export async function captureGitSafety(repositoryDirectory) {
  try {
    const identities = await Promise.all(
      identityPaths(repositoryDirectory).map((specification) =>
        captureIdentity(repositoryDirectory, specification),
      ),
    );
    return Object.freeze(identities);
  } catch (cause) {
    if (cause instanceof GitSafetyError) throw cause;
    throw new GitSafetyError('Git safety identity is unavailable', { cause });
  }
}

export async function assertGitSafety(repositoryDirectory, expectedIdentities) {
  if (!expectedIdentities) {
    throw new GitSafetyError('Git safety identity was not recorded');
  }
  const currentIdentities = await captureGitSafety(repositoryDirectory);
  const comparedFields = [
    'path',
    'kind',
    'canonicalPath',
    'device',
    'inode',
    'linkCount',
    'content',
    'sha256',
  ];
  for (const [index, current] of currentIdentities.entries()) {
    const expected = expectedIdentities[index];
    const changedFields = comparedFields.filter(
      (field) => expected === undefined || current[field] !== expected[field],
    );
    if (changedFields.length > 0) {
      throw new GitSafetyError(
        `Git safety identity ${index} changed: ${changedFields.join(', ')}`,
      );
    }
  }
  if (currentIdentities.length !== expectedIdentities.length) {
    throw new GitSafetyError('Git safety identity count changed');
  }
}

function assertIdentityContent(identity, expectedContent, label) {
  const content = Buffer.from(identity.content, 'base64').toString('utf8');
  if (content !== expectedContent) {
    throw new GitSafetyError(`${label} does not contain the fixed safe configuration`);
  }
}

function assertHandleIdentity(identity, metadata) {
  if (
    identity.device !== metadata.dev ||
    identity.inode !== metadata.ino ||
    metadata.nlink !== 1 ||
    !metadata.isFile()
  ) {
    throw new GitSafetyError('Local Git config identity changed before replacement');
  }
}

export async function prepareGitSafetyForResume(repositoryDirectory) {
  const before = await captureGitSafety(repositoryDirectory);
  assertIdentityContent(before.at(-1), GLOBAL_CONFIG, 'Controlled global Git config');
  const localConfigIdentity = before[2];
  const flags = constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0);
  let configHandle;
  try {
    configHandle = await open(localConfigIdentity.path, flags);
    assertHandleIdentity(localConfigIdentity, await configHandle.stat());
    await configHandle.truncate(0);
    await configHandle.writeFile(LOCAL_CONFIG, 'utf8');
    await configHandle.sync();
    assertHandleIdentity(localConfigIdentity, await configHandle.stat());
  } catch (cause) {
    if (cause instanceof GitSafetyError) throw cause;
    throw new GitSafetyError('Unable to establish the fixed local Git config', { cause });
  } finally {
    await configHandle?.close();
  }
  const identities = await captureGitSafety(repositoryDirectory);
  assertIdentityContent(identities[2], LOCAL_CONFIG, 'Local Git config');
  assertIdentityContent(identities.at(-1), GLOBAL_CONFIG, 'Controlled global Git config');
  return identities;
}
