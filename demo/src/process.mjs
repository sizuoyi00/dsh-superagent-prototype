import { spawn } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;

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
  if (!Array.isArray(args) || args.some((argument) => typeof argument !== 'string')) {
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

    const child = spawn(command, args, {
      cwd: normalizedOptions.cwd,
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

    child.stdout.on('data', (chunk) => capture(stdoutChunks, chunk));
    child.stderr.on('data', (chunk) => capture(stderrChunks, chunk));

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      forceKillTimer = setTimeout(() => child.kill('SIGKILL'), 1_000);
      forceKillTimer.unref();
    }, normalizedOptions.timeoutMs);
    timeout.unref();

    child.once('error', (cause) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(forceKillTimer);
      reject(
        new ProcessError(`Failed to start process: ${command}`, undefined, {
          cause,
        }),
      );
    });

    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(forceKillTimer);

      const result = {
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        code,
        signal,
        timedOut,
        outputTruncated,
      };

      if (normalizedOptions.rejectOnNonZero && (timedOut || code !== 0)) {
        const reason = timedOut ? 'timed out' : `exited with code ${code}`;
        reject(new ProcessError(`Process ${command} ${reason}`, result));
        return;
      }

      resolve(result);
    });
  });
}
