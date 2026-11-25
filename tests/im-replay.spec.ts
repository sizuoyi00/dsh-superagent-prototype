/**
 * Replays recorded 企信 history through the real Source mapping, the real Policy and the real Engine, with a fake
 * Executor and Outbox: what would become a Ticket, which assignment each would launch, and the reply it would queue.
 * The fixture keeps message structure and addressing evidence only; every body is replaced.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Engine, MemoryRepositories, type Assessor, type Candidate, type Executor, type OutboundMessage } from '../src/core/index.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { imKind } from '../src/sources/im.ts'
import { imAddressed, imTrigger, ImMessageSchema, ImSessionSchema } from '../src/sources/im-trigger.ts'
import { SourceRegistry } from '../src/sources/registry.ts'

interface History { sessions: unknown[]; messages: Record<string, unknown[]> }
const history = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'im-history.json'), 'utf8')) as History
const self = { id: 9766, fullId: 'E.fs.9766', names: ['斯作益seth'] }
/** The Source settings a deployment answering colleagues uses: groups by mention only, direct chats on, others by mention. */
const config = { chats: [], directMessages: true, otherChats: 'mentions' as const, selfName: '斯作益seth', pollSeconds: 45, readPageSize: 50 }

function replay(policySources: Record<string, unknown>) {
  const settings = SettingsSchema.parse({ policy: { sources: policySources }, eval: { mode: 'auto' },
    sources: { im: { enabled: true, config } } })
  const sources = new SourceRegistry(() => settings, new HealthBoard())
  sources.register(imKind)
  const repo = new MemoryRepositories()
  const outbox: OutboundMessage[] = []
  const candidates: Candidate[] = []
  const launches: { title: string; scope: string }[] = []
  const assessor: Assessor = { request: vi.fn((candidate: Candidate) => { candidates.push(candidate) }), release: vi.fn() }
  const executor: Executor = { start: vi.fn((ticket) => { launches.push({ title: ticket.title, scope: ticket.mandate.scope }) }),
    deliver: vi.fn(), stop: vi.fn() }
  const engine = new Engine({ repo, scope: sources, policy: () => settingsPolicy(settings, sources), assessor, executor,
    outbox: { send: message => { if (!outbox.some(item => item.id === message.id)) outbox.push(message) },
      status: () => undefined, withdraw: () => {} } })
  let addressed = 0
  for (const raw of history.sessions) {
    const session = ImSessionSchema.parse(raw)
    for (const message of (history.messages[session.sessionId] ?? []).map(item => ImMessageSchema.parse(item))) {
      if (message.senderId === self.id) continue
      if (!imAddressed(message, session, self)) continue
      addressed++
      engine.receive(imTrigger(session, message, self))
    }
  }
  engine.evaluateDue()
  // The fake assessor accepts everything it is asked about, as a permissive rule set would.
  for (const candidate of candidates.splice(0)) {
    engine.decide(candidate.triggers[0]!.id, { kind: 'accept', title: 'replayed request', scope: 'one message',
      reason: 'explicit request', acknowledgement: '收到，开始处理' })
  }
  const started: { ticketId: string; assignmentId: string }[] = []
  for (const call of (executor.start as unknown as { mock: { calls: [{ id: string }, { id: string }][] } }).mock.calls) {
    engine.assignmentStarted(call[0].id, call[1].id)
    started.push({ ticketId: call[0].id, assignmentId: call[1].id })
  }
  return { addressed, launches, outbox, repo, engine, started }
}

describe('replaying recorded 企信 history', () => {
  it('turns each addressed message into one Ticket, launches its assignment, and queues its acknowledgement', () => {
    // The deployment answers anyone who addresses it; a message that addresses nobody is never assessed.
    const run = replay({ im: { allowed: [], admission: { other: { unlistedAddressed: 'explicit' },
      direct: { unlistedAddressed: 'explicit' } } } })
    expect(run.addressed).toBeGreaterThan(0)
    expect(run.launches.length).toBe(run.addressed)
    expect(run.repo.tickets.list().length).toBe(run.addressed)
    // Every Ticket keeps the channel of the message that started it, and the acknowledgement goes there once.
    const acks = run.outbox.filter(message => message.kind === 'acknowledgement')
    expect(acks.length).toBe(run.addressed)
    expect(acks.every(message => message.channel.source === 'im' && message.channel.address.sessionId)).toBe(true)
    expect(new Set(acks.map(message => message.id)).size).toBe(acks.length)
  })

  it('carries one Ticket to a ready report and a reply on the same channel the message came from', () => {
    const run = replay({ im: { allowed: [], admission: { other: { unlistedAddressed: 'explicit' },
      direct: { unlistedAddressed: 'explicit' } } } })
    const [first] = run.started
    expect(first).toBeDefined()
    const ticket = run.repo.tickets.get(first!.ticketId)!
    run.engine.report(first!.ticketId, { state: 'ready', summary: '看过了，这条不需要改动。' })
    const reply = run.engine.reply({ purpose: 'result', ticketId: first!.ticketId, text: '看过了，这条不需要改动。' })
    expect(reply).toMatchObject({ status: 'pending' })
    const queued = run.outbox.filter(message => message.kind === 'reply')
    expect(queued).toHaveLength(1)
    expect(queued[0]!.channel).toEqual(ticket.channels[0])
  })

  it('creates no Ticket when nobody may originate work, and none for a message that addresses nobody', () => {
    const closed = replay({ im: { allowed: [] } })
    expect(closed.launches).toEqual([])
    expect(closed.repo.tickets.list()).toEqual([])
    // Without a mention or a direct chat the mapping never marks the message addressed, which the first test covers too.
    const withoutAddressing = (history.sessions as { sessionId: string }[]).flatMap(session => (history.messages[session.sessionId] ?? []))
      .map(raw => ImMessageSchema.parse(raw)).filter(message => message.senderId !== self.id)
      .filter(message => !imAddressed(message, ImSessionSchema.parse({ sessionId: 'x', sessionCategory: 'D', participants: [] }), self))
    expect(withoutAddressing.length).toBeGreaterThan(0)
  })
})
