import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

const NODE_FILE_SYSTEM = Object.freeze({
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
})

function serializeJsonSafe(value) {
  let serialized

  try {
    serialized = JSON.stringify(value)
  } catch (error) {
    throw new TypeError('state must be JSON-safe', { cause: error })
  }

  if (serialized === undefined) {
    throw new TypeError('state must be JSON-safe')
  }

  const roundTripped = JSON.parse(serialized)
  if (!isDeepStrictEqual(value, roundTripped)) {
    throw new TypeError('state must be JSON-safe without data loss')
  }

  return serialized
}

function validateState(state, expectedSchemaVersion) {
  if (state === null || typeof state !== 'object' || Array.isArray(state)) {
    throw new TypeError('state must be an object')
  }
  if (!Number.isInteger(state.schemaVersion) || state.schemaVersion < 1) {
    throw new TypeError('state.schemaVersion must be a positive integer')
  }
  if (state.schemaVersion !== expectedSchemaVersion) {
    throw new TypeError(
      `state.schemaVersion must be ${expectedSchemaVersion}; received ${state.schemaVersion}`,
    )
  }
  if (typeof state.phase !== 'string' || state.phase.trim().length === 0) {
    throw new TypeError('state.phase must be a non-empty string')
  }
}

export class StoreError extends Error {
  constructor(filePath, cause) {
    super(
      `Unable to persist demo state at "${filePath}". Use reset to rebuild the demo state.`,
      { cause },
    )
    this.name = 'StoreError'
    this.code = 'STORE_ERROR'
    this.filePath = filePath
  }
}

function createLoadError(filePath, reason, cause) {
  return new Error(
    `Unable to load state from "${filePath}": ${reason}. Use reset to rebuild the demo state.`,
    { cause },
  )
}

async function tryUnlink(fileSystem, filePath) {
  try {
    await fileSystem.unlink(filePath)
    return undefined
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return undefined
    }
    return error
  }
}

/**
 * Persists JSON state with invocation-ordered load/save calls per instance.
 * Separate JsonStore instances and processes do not coordinate access to a file.
 */
export class JsonStore {
  #expectedSchemaVersion
  #filePath
  #fileSystem
  #initialStateJson
  #operationQueue = Promise.resolve()

  constructor({ filePath, fileSystem = NODE_FILE_SYSTEM, initialState }) {
    if (typeof filePath !== 'string' || filePath.trim().length === 0) {
      throw new TypeError('filePath must be a non-empty string')
    }

    const initialStateJson = serializeJsonSafe(initialState)
    const initialStateSnapshot = JSON.parse(initialStateJson)
    validateState(initialStateSnapshot, initialStateSnapshot.schemaVersion)

    this.#filePath = filePath
    this.#fileSystem = Object.freeze({ ...fileSystem })
    this.#expectedSchemaVersion = initialStateSnapshot.schemaVersion
    this.#initialStateJson = initialStateJson
  }

  load() {
    return this.#enqueue(() => this.#load())
  }

  async #load() {
    let contents

    try {
      contents = await this.#fileSystem.readFile(this.#filePath, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') {
        await this.#writeAtomically(this.#initialStateJson)
        return JSON.parse(this.#initialStateJson)
      }
      throw new StoreError(this.#filePath, error)
    }

    let state
    try {
      state = JSON.parse(contents)
    } catch (error) {
      throw createLoadError(this.#filePath, 'the file contains invalid JSON', error)
    }

    try {
      serializeJsonSafe(state)
      validateState(state, this.#expectedSchemaVersion)
    } catch (error) {
      throw createLoadError(this.#filePath, error.message, error)
    }

    return state
  }

  save(state) {
    let serialized
    let validationError

    try {
      serialized = serializeJsonSafe(state)
      validateState(state, this.#expectedSchemaVersion)
    } catch (error) {
      validationError = new TypeError(
        `Unable to save state to "${this.#filePath}": ${error.message}`,
        { cause: error },
      )
    }

    if (validationError) {
      return this.#enqueue(() => Promise.reject(validationError))
    }
    return this.#enqueue(() => this.#writeAtomically(serialized))
  }

  #enqueue(operation) {
    const result = this.#operationQueue.then(operation)
    this.#operationQueue = result.catch(() => undefined)
    return result
  }

  async #writeAtomically(serialized) {
    const parentDirectory = dirname(this.#filePath)
    const temporaryPath = join(
      parentDirectory,
      `.${basename(this.#filePath)}.${randomUUID()}.tmp`,
    )
    let writeError
    try {
      await this.#fileSystem.mkdir(parentDirectory, { recursive: true })
      await this.#fileSystem.writeFile(temporaryPath, `${serialized}\n`, {
        encoding: 'utf8',
        flag: 'wx',
      })
      // Same-directory rename is process-level atomic replacement. This store
      // intentionally does not claim fsync durability across a power loss.
      await this.#fileSystem.rename(temporaryPath, this.#filePath)
      return
    } catch (error) {
      writeError = error
    }

    const cleanupError = await tryUnlink(this.#fileSystem, temporaryPath)
    const cause = cleanupError
      ? new AggregateError(
        [writeError, cleanupError],
        'Atomic state write and temporary-file cleanup both failed',
      )
      : writeError
    throw new StoreError(this.#filePath, cause)
  }
}
