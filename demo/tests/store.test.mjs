import assert from 'node:assert/strict'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { setImmediate as waitForImmediate } from 'node:timers/promises'

import { JsonStore } from '../src/store.mjs'

const NODE_FILE_SYSTEM = Object.freeze({
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
})

function createState(overrides = {}) {
  return {
    schemaVersion: 1,
    phase: 'ready',
    timeline: [],
    ...overrides,
  }
}

function createMissingFileBarrier() {
  let rejectRead
  const missingRead = new Promise((resolve, reject) => {
    rejectRead = reject
  })
  missingRead.catch(() => {})
  const files = new Map()
  const temporaryFiles = new Map()
  let isFirstRead = true

  return {
    fileSystem: {
      async mkdir() {},
      async readFile(path) {
        if (isFirstRead) {
          isFirstRead = false
          return missingRead
        }
        if (!files.has(path)) {
          throw Object.assign(new Error('missing'), { code: 'ENOENT' })
        }
        return files.get(path)
      },
      async rename(source, target) {
        files.set(target, temporaryFiles.get(source))
        temporaryFiles.delete(source)
      },
      async unlink(path) {
        if (!temporaryFiles.delete(path)) {
          throw Object.assign(new Error('missing'), { code: 'ENOENT' })
        }
      },
      async writeFile(path, contents) {
        temporaryFiles.set(path, contents)
      },
    },
    readState(path) {
      const contents = files.get(path)
      return contents === undefined ? undefined : JSON.parse(contents)
    },
    releaseMissingRead() {
      rejectRead(Object.assign(new Error('missing'), { code: 'ENOENT' }))
    },
  }
}

async function captureRejection(promise) {
  let capturedError
  await assert.rejects(promise, (error) => {
    capturedError = error
    return true
  })
  return capturedError
}

function assertStableStoreError(error, targetPath, cause) {
  assert.equal(error.name, 'StoreError')
  assert.equal(error.code, 'STORE_ERROR')
  assert.equal(error.filePath, targetPath)
  assert.equal(
    error.message,
    `Unable to persist demo state at "${targetPath}". Use reset to rebuild the demo state.`,
  )
  assert.equal(error.message.includes('known-temp-uuid'), false)
  assert.equal(error.cause, cause)
}

describe('JsonStore', () => {
  let directory
  let filePath

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'superagent-json-store-'))
    filePath = join(directory, 'nested', 'state.json')
  })

  afterEach(async () => {
    await rm(directory, { force: true, recursive: true })
  })

  it('initializes a missing file from an independent snapshot of the provided state', async () => {
    const initialState = createState()
    const store = new JsonStore({ filePath, initialState })

    initialState.phase = 'changed-after-construction'
    initialState.timeline.push({ type: 'changed-after-construction' })

    const loaded = await store.load()
    const persisted = JSON.parse(await readFile(filePath, 'utf8'))

    assert.deepEqual(loaded, createState())
    assert.deepEqual(persisted, createState())
    assert.notStrictEqual(loaded, initialState)
  })

  it('round-trips a saved state', async () => {
    const store = new JsonStore({ filePath, initialState: createState() })
    const state = createState({
      phase: 'running',
      timeline: [{ sequence: 1, type: 'assignment.started' }],
    })

    await store.save(state)

    assert.deepEqual(await store.load(), state)
  })

  it('returns an independent object on every load', async () => {
    const store = new JsonStore({ filePath, initialState: createState() })
    await store.save(createState({ timeline: [{ sequence: 1 }] }))

    const first = await store.load()
    const second = await store.load()
    first.phase = 'mutated'
    first.timeline[0].sequence = 999

    assert.deepEqual(second, createState({ timeline: [{ sequence: 1 }] }))
    assert.deepEqual(
      await store.load(),
      createState({ timeline: [{ sequence: 1 }] }),
    )
  })

  it('serializes a missing-file load followed by save in invocation order', async () => {
    const barrier = createMissingFileBarrier()
    const store = new JsonStore({
      filePath,
      fileSystem: barrier.fileSystem,
      initialState: createState(),
    })
    const runningState = createState({ phase: 'running' })

    const loadPromise = store.load()
    const savePromise = store.save(runningState)
    await waitForImmediate()
    barrier.releaseMissingRead()

    await Promise.all([loadPromise, savePromise])

    assert.deepEqual(barrier.readState(filePath), runningState)
    assert.deepEqual(await store.load(), runningState)
  })

  it('settles invalid saves only after earlier operations finish', async () => {
    const barrier = createMissingFileBarrier()
    const store = new JsonStore({
      filePath,
      fileSystem: barrier.fileSystem,
      initialState: createState(),
    })
    const settled = []

    const loadPromise = store.load().then(() => settled.push('load'))
    const invalidSavePromise = store
      .save(createState({ schemaVersion: 2 }))
      .catch((error) => {
        settled.push('invalid-save')
        return error
      })
    await waitForImmediate()

    assert.deepEqual(settled, [])

    barrier.releaseMissingRead()
    const [, error] = await Promise.all([loadPromise, invalidSavePromise])

    assert.deepEqual(settled, ['load', 'invalid-save'])
    assert.equal(error instanceof TypeError, true)
  })

  it('snapshots a save input before waiting for earlier operations', async () => {
    const barrier = createMissingFileBarrier()
    const store = new JsonStore({
      filePath,
      fileSystem: barrier.fileSystem,
      initialState: createState(),
    })
    const state = createState({ phase: 'running' })

    const loadPromise = store.load()
    const savePromise = store.save(state)
    state.phase = 'mutated-after-save-call'
    await waitForImmediate()
    barrier.releaseMissingRead()

    await Promise.all([loadPromise, savePromise])

    assert.deepEqual(barrier.readState(filePath), createState({ phase: 'running' }))
  })

  it('continues processing queued operations after a store failure', async () => {
    const cause = new Error('first rename fails')
    let shouldFailRename = true
    const store = new JsonStore({
      filePath,
      fileSystem: {
        ...NODE_FILE_SYSTEM,
        async rename(source, target) {
          if (shouldFailRename) {
            shouldFailRename = false
            throw cause
          }
          await rename(source, target)
        },
      },
      initialState: createState(),
    })

    await assert.rejects(store.save(createState({ phase: 'queued' })))
    await store.save(createState({ phase: 'running' }))

    assert.deepEqual(await store.load(), createState({ phase: 'running' }))
  })

  it('rejects a persisted state with an unexpected schema version', async () => {
    const store = new JsonStore({ filePath, initialState: createState() })
    await mkdir(join(directory, 'nested'), { recursive: true })
    await writeFile(filePath, JSON.stringify(createState({ schemaVersion: 2 })))

    await assert.rejects(
      store.load(),
      (error) => error instanceof Error
        && error.message.includes(filePath)
        && /schemaVersion/.test(error.message)
        && /reset/i.test(error.message),
    )
  })

  it('rejects a persisted state that does not satisfy the minimum state schema', async () => {
    const store = new JsonStore({ filePath, initialState: createState() })
    await mkdir(join(directory, 'nested'), { recursive: true })
    await writeFile(filePath, JSON.stringify({ schemaVersion: 1 }))

    await assert.rejects(
      store.load(),
      (error) => error instanceof Error
        && error.message.includes(filePath)
        && /phase/.test(error.message)
        && /reset/i.test(error.message),
    )
  })

  it('reports corrupt JSON with the state path and reset guidance', async () => {
    const store = new JsonStore({ filePath, initialState: createState() })
    await mkdir(join(directory, 'nested'), { recursive: true })
    await writeFile(filePath, '{ definitely not JSON')

    await assert.rejects(
      store.load(),
      (error) => error instanceof Error
        && error.message.includes(filePath)
        && /JSON/i.test(error.message)
        && /reset/i.test(error.message),
    )
  })

  it('does not load valid JSON that would produce a non-JSON-safe state', async () => {
    const store = new JsonStore({ filePath, initialState: createState() })
    await mkdir(join(directory, 'nested'), { recursive: true })
    await writeFile(
      filePath,
      '{"schemaVersion":1,"phase":"ready","score":1e400}',
    )

    await assert.rejects(
      store.load(),
      (error) => error instanceof Error
        && error.message.includes(filePath)
        && /JSON-safe/.test(error.message)
        && /reset/i.test(error.message),
    )
  })

  it('rejects states that cannot round-trip through JSON without data loss', async () => {
    const store = new JsonStore({ filePath, initialState: createState() })
    const cyclicState = createState()
    cyclicState.self = cyclicState
    const invalidStates = [
      createState({ extra: undefined }),
      createState({ score: Number.NaN }),
      createState({ count: 1n }),
      createState({ createdAt: new Date('2026-11-03T00:00:00.000Z') }),
      cyclicState,
    ]

    for (const state of invalidStates) {
      await assert.rejects(
        store.save(state),
        (error) => error instanceof TypeError && /JSON-safe/.test(error.message),
      )
    }
  })

  it('rejects a non-JSON-safe initial state at construction', () => {
    assert.throws(
      () => new JsonStore({
        filePath,
        initialState: createState({ extra: undefined }),
      }),
      (error) => error instanceof TypeError && /JSON-safe/.test(error.message),
    )
  })

  it('validates the state schema before saving', async () => {
    const store = new JsonStore({ filePath, initialState: createState() })

    await assert.rejects(store.save(createState({ schemaVersion: 2 })), /schemaVersion/)
    await assert.rejects(store.save(createState({ phase: '' })), /phase/)
  })

  it('leaves no temporary file after a successful atomic save', async () => {
    const store = new JsonStore({ filePath, initialState: createState() })

    await store.save(createState({ phase: 'running' }))

    const entries = await readdir(join(directory, 'nested'))
    assert.deepEqual(entries, [basename(filePath)])
  })

  it('wraps low-level read, mkdir, and write failures as stable StoreErrors', async () => {
    for (const operation of ['readFile', 'mkdir', 'writeFile']) {
      const cause = new Error(`${operation} failed at known-temp-uuid`)
      const fileSystem = {
        ...NODE_FILE_SYSTEM,
        [operation]: async () => {
          throw cause
        },
      }
      const store = new JsonStore({
        filePath,
        fileSystem,
        initialState: createState(),
      })
      const action = operation === 'readFile'
        ? store.load()
        : store.save(createState({ phase: 'running' }))

      const error = await captureRejection(action)

      assertStableStoreError(error, filePath, cause)
    }
  })

  it('preserves the old state and removes its temp file when rename fails', async () => {
    const oldState = createState({ phase: 'queued' })
    const store = new JsonStore({ filePath, initialState: createState() })
    await store.save(oldState)
    const cause = new Error('rename failed at known-temp-uuid')
    const failingStore = new JsonStore({
      filePath,
      fileSystem: {
        ...NODE_FILE_SYSTEM,
        async rename() {
          throw cause
        },
      },
      initialState: createState(),
    })

    const error = await captureRejection(
      failingStore.save(createState({ phase: 'running' })),
    )

    assertStableStoreError(error, filePath, cause)
    assert.deepEqual(JSON.parse(await readFile(filePath, 'utf8')), oldState)
    assert.deepEqual(await readdir(join(directory, 'nested')), [basename(filePath)])
  })

  it('reports both the atomic write and cleanup errors as the StoreError cause', async () => {
    const writeError = new Error('rename failed at known-temp-uuid')
    const cleanupError = new Error('cleanup failed at known-temp-uuid')
    const store = new JsonStore({
      filePath,
      fileSystem: {
        ...NODE_FILE_SYSTEM,
        async rename() {
          throw writeError
        },
        async unlink() {
          throw cleanupError
        },
      },
      initialState: createState(),
    })

    const error = await captureRejection(
      store.save(createState({ phase: 'running' })),
    )

    assert.equal(error.name, 'StoreError')
    assert.equal(
      error.message,
      `Unable to persist demo state at "${filePath}". Use reset to rebuild the demo state.`,
    )
    assert.equal(error.cause instanceof AggregateError, true)
    assert.deepEqual(error.cause.errors, [writeError, cleanupError])
  })
})
