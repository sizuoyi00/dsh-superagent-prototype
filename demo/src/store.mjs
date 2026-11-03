import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

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

function createLoadError(filePath, reason, cause) {
  return new Error(
    `Unable to load state from "${filePath}": ${reason}. Reset the demo to replace this state file.`,
    { cause },
  )
}

async function tryUnlink(filePath) {
  try {
    await unlink(filePath)
    return undefined
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return undefined
    }
    return error
  }
}

export class JsonStore {
  #expectedSchemaVersion
  #filePath
  #initialStateJson

  constructor({ filePath, initialState }) {
    if (typeof filePath !== 'string' || filePath.trim().length === 0) {
      throw new TypeError('filePath must be a non-empty string')
    }

    const initialStateJson = serializeJsonSafe(initialState)
    const initialStateSnapshot = JSON.parse(initialStateJson)
    validateState(initialStateSnapshot, initialStateSnapshot.schemaVersion)

    this.#filePath = filePath
    this.#expectedSchemaVersion = initialStateSnapshot.schemaVersion
    this.#initialStateJson = initialStateJson
  }

  async load() {
    let contents

    try {
      contents = await readFile(this.#filePath, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') {
        await this.#writeAtomically(this.#initialStateJson)
        return JSON.parse(this.#initialStateJson)
      }
      throw createLoadError(this.#filePath, error.message, error)
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

  async save(state) {
    let serialized

    try {
      serialized = serializeJsonSafe(state)
      validateState(state, this.#expectedSchemaVersion)
    } catch (error) {
      throw new TypeError(
        `Unable to save state to "${this.#filePath}": ${error.message}`,
        { cause: error },
      )
    }

    await this.#writeAtomically(serialized)
  }

  async #writeAtomically(serialized) {
    const parentDirectory = dirname(this.#filePath)
    const temporaryPath = join(
      parentDirectory,
      `.${basename(this.#filePath)}.${randomUUID()}.tmp`,
    )
    await mkdir(parentDirectory, { recursive: true })

    let writeError
    try {
      await writeFile(temporaryPath, `${serialized}\n`, {
        encoding: 'utf8',
        flag: 'wx',
      })
      await rename(temporaryPath, this.#filePath)
    } catch (error) {
      writeError = error
    }

    const cleanupError = await tryUnlink(temporaryPath)
    if (writeError && cleanupError) {
      throw new AggregateError(
        [writeError, cleanupError],
        `Unable to save state to "${this.#filePath}" and clean up its temporary file`,
      )
    }
    if (writeError) {
      throw writeError
    }
    if (cleanupError) {
      throw cleanupError
    }
  }
}
