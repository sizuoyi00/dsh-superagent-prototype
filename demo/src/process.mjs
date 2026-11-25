import { spawn } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;
const TIMEOUT_GRACE_MS = 200;

export class ProcessError extends Error {
  constructor(message, result, options = {}) {
    super(message, options);
    this.name = 'ProcessError';
    this.result = result;
  }
}

function validateOptions(command, args, options) {
  if (typeof command !== 'string' || command.length === 0) {
    throw new TypeError('command must be a non-empty string');
  }
  if (
    !Array.isArray(args) ||
    args.some((argument) => typeof argument !== 'string')
  ) {
    throw new TypeError('args must be an array of strings');
  }
  if (typeof options.cwd !== 'string' || options.cwd.length === 0) {
    throw new TypeError('cwd must be an explicit non-empty path');
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new TypeError('timeoutMs must be a positive integer');
  }
  if (
    !Number.isInteger(options.maxOutputBytes) ||
    options.maxOutputBytes <= 0
  ) {
    throw new TypeError('maxOutputBytes must be a positive integer');
  }
}

export function runProcess(command, args = [], options = {}) {
  const normalizedOptions = {
    cwd: options.cwd,
    env: options.env,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxOutputBytes: options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    rejectOnNonZero: options.rejectOnNonZero ?? false,
  };

  validateOptions(command, args, normalizedOptions);

  return new Promise((resolve, reject) => {
    const stdoutChunks = [];
    const stderrChunks = [];
    let capturedBytes = 0;
    let outputTruncated = false;
    let timedOut = false;
    let settled = false;
    let forceKillTimer;
    const usesPosixProcessGroup = process.platform !== 'win32';
    const terminationScope = usesPosixProcessGroup
      ? 'posix-process-group'
      : 'direct-child-fallback';

    const child = spawn(command, args, {
      cwd: normalizedOptions.cwd,
      detached: usesPosixProcessGroup,
      env: normalizedOptions.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const capture = (chunks, chunk) => {
      const remainingBytes = normalizedOptions.maxOutputBytes - capturedBytes;
      if (remainingBytes <= 0) {
        outputTruncated = true;
        return;
      }

      const capturedChunk = chunk.subarray(0, remainingBytes);
      chunks.push(capturedChunk);
      capturedBytes += capturedChunk.length;
      if (capturedChunk.length < chunk.length) {
        outputTruncated = true;
      }
    };

    const onStdout = (chunk) => capture(stdoutChunks, chunk);
    const onStderr = (chunk) => capture(stderrChunks, chunk);
    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);

    const sendSignal = (signal) => {
      if (usesPosixProcessGroup && child.pid) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch (error) {
          if (error.code !== 'ESRCH') child.kill(signal);
          return;
        }
      }
      child.kill(signal);
    };

    let timeout;
    const cleanup = ({ destroyStreams = false } = {}) => {
      clearTimeout(timeout);
      clearTimeout(forceKillTimer);
      child.removeListener('error', onError);
      child.removeListener('close', onClose);
      child.stdout.removeListener('data', onStdout);
      child.stderr.removeListener('data', onStderr);
      if (destroyStreams) {
        child.stdout.destroy();
        child.stderr.destroy();
      }
    };

    const settle = (code, signal, options = {}) => {
      if (settled) return;
      settled = true;
      cleanup(options);

      const result = {
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        code,
        signal,
        timedOut,
        outputTruncated,
        terminationScope,
      };

      if (normalizedOptions.rejectOnNonZero && (timedOut || code !== 0)) {
        const reason = timedOut ? 'timed out' : `exited with code ${code}`;
        reject(new ProcessError(`Process ${command} ${reason}`, result));
        return;
      }

      resolve(result);
    };

    const onError = (cause) => {
      if (settled) return;
      settled = true;
      cleanup({ destroyStreams: true });
      reject(
        new ProcessError(`Failed to start process: ${command}`, undefined, {
          cause,
        }),
      );
    };
    const onClose = (code, signal) => settle(code, signal);

    child.once('error', onError);
    child.once('close', onClose);

    timeout = setTimeout(() => {
      timedOut = true;
      sendSignal('SIGTERM');
      forceKillTimer = setTimeout(() => {
        sendSignal('SIGKILL');
        settle(child.exitCode, child.signalCode ?? 'SIGKILL', {
          destroyStreams: true,
        });
      }, TIMEOUT_GRACE_MS);
      forceKillTimer.unref();
    }, normalizedOptions.timeoutMs);
    timeout.unref();
  });
}
