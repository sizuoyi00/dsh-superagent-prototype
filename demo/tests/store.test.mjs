import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { JsonStore } from '../src/store.mjs'

function createState(overrides = {}) {
  return {
    schemaVersion: 1,
    phase: 'ready',
    timeline: [],
    ...overrides,
  }
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

  it('cleans up its temporary file when the atomic rename fails', async () => {
    const blockedFilePath = join(directory, 'blocked-state.json')
    const store = new JsonStore({
      filePath: blockedFilePath,
      initialState: createState(),
    })
    await mkdir(blockedFilePath)

    await assert.rejects(store.save(createState({ phase: 'running' })))

    const entries = await readdir(directory)
    assert.deepEqual(entries, [basename(blockedFilePath)])
  })
})
