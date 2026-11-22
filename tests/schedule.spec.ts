/** Schedule Source: cron parsing, next firing, and the Trigger one firing builds. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Trigger } from '../src/core/index.ts'
import { nextFire, parseCron, runSchedule, scheduleTrigger, scheduleKind, type ScheduleConfig } from '../src/sources/schedule.ts'

const at = (text: string) => new Date(text)
const next = (cron: string, from: string) => nextFire(parseCron(cron), at(from))?.toISOString()

describe('cron parsing', () => {
  it('reads five fields, steps, ranges, and lists', () => {
    const cron = parseCron('*/15 9-17 1,15 * 1-5')
    expect([...cron.minute]).toEqual([0, 15, 30, 45])
    expect([...cron.hour]).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17])
    expect([...cron.day]).toEqual([1, 15])
    expect([...cron.month]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    expect([...cron.weekday]).toEqual([1, 2, 3, 4, 5])
  })
  it('accepts 7 as Sunday and marks both day fields restricted', () => {
    expect([...parseCron('0 0 * * 7').weekday]).toEqual([0])
    expect(parseCron('0 0 1 * 1').either).toBe(true)
    expect(parseCron('0 0 1 * *').either).toBe(false)
  })
  it('rejects a wrong field count and out-of-range values', () => {
    expect(() => parseCron('0 9 * *')).toThrow(/five fields/)
    expect(() => parseCron('60 9 * * *')).toThrow(/Invalid cron field/)
    expect(() => parseCron('0 9 * * 8')).toThrow(/Invalid cron field/)
    expect(() => parseCron('*/0 9 * * *')).toThrow(/Invalid cron field/)
  })
})

describe('next firing', () => {
  it('finds the next matching minute in local time', () => {
    expect(next('*/15 * * * *', '2026-11-22T00:07:30')).toBe(at('2026-11-22T00:15:00').toISOString())
    expect(next('0 9 * * *', '2026-11-22T00:07:30')).toBe(at('2026-11-22T09:00:00').toISOString())
  })
  it('skips the current minute so one minute fires once', () => {
    expect(next('* * * * *', '2026-11-22T10:00:00')).toBe(at('2026-11-22T10:01:00').toISOString())
  })
  it('matches either restricted day field, and both when only one is restricted', () => {
    // 2026-11-22 is a Sunday, so `* * 22 * 1` (day 22 or Monday) matches that day.
    expect(next('0 0 22 * 1', '2026-11-22T00:00:00')).toBe(at('2026-11-23T00:00:00').toISOString())
    expect(next('0 0 23 * *', '2026-11-22T12:00:00')).toBe(at('2026-11-23T00:00:00').toISOString())
  })
  it('returns undefined when nothing matches within a year', () => {
    expect(nextFire(parseCron('0 0 30 2 *'), at('2026-01-01T00:00:00'))).toBeUndefined()
  })
})

describe('the Trigger one firing builds', () => {
  const config: ScheduleConfig = { cron: '*/15 * * * *', actor: 'me', instruction: 'Check the dependencies.' }
  it('carries the instruction, the account, and a minute-stable id', () => {
    const fire = at('2026-11-22T10:15:00')
    const trigger = scheduleTrigger('schedule', config, fire)
    expect(trigger).toMatchObject({ source: 'schedule', human: true, addressed: 'direct', text: 'Check the dependencies.',
      actor: { source: 'schedule', id: 'me' }, threads: [{ source: 'schedule', id: `schedule:${fire.toISOString()}` }], at: fire.toISOString() })
    expect(scheduleTrigger('schedule', config, fire).id).toBe(trigger.id)
    expect(scheduleTrigger('schedule', config, at('2026-11-22T10:30:00')).id).not.toBe(trigger.id)
    // Each firing gets its own Thread, so a changed instruction starts a new Ticket.
    expect(scheduleTrigger('schedule', config, at('2026-11-22T10:30:00')).threads[0]!.id)
      .not.toBe(trigger.threads[0]!.id)
  })
})

describe('the Source settings', () => {
  it('rejects an invalid expression and defaults the rest', () => {
    expect(scheduleKind.schema.safeParse({ cron: 'nope' }).success).toBe(false)
    expect(scheduleKind.schema.parse({})).toEqual({ cron: '0 9 * * *', actor: '', instruction: '' })
  })
})

describe('the loop', () => {
  const context = (config: ScheduleConfig | undefined, last?: string) => {
    const state = { last }
    const receive = vi.fn(async (_trigger: Trigger) => ({ result: 'received' as const }))
    const report = vi.fn()
    return { receive, report, state,
      value: { ready: Promise.resolve(), config: () => config, report,
        state: { get: () => state.last, set: (_key: string, value: string) => { state.last = value }, keys: () => [] },
        threads: { describe: vi.fn() }, receive } as unknown as Parameters<typeof runSchedule>[0] }
  }
  afterEach(() => { vi.useRealTimers() })
  it('fires inside the minute it waited for instead of searching for the next one', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-22T00:29:00'))
    const ctx = context({ cron: '*/5 * * * *', actor: 'me', instruction: 'Check.' })
    const controller = new AbortController()
    const running = runSchedule(ctx.value, controller.signal)
    await vi.advanceTimersByTimeAsync(70_000)
    expect(ctx.receive).toHaveBeenCalledTimes(1)
    expect(ctx.receive.mock.calls[0]![0]).toMatchObject({ source: 'schedule', text: 'Check.', actor: { source: 'schedule', id: 'me' } })
    expect(ctx.state.last).toBe(new Date('2026-11-22T00:30:00').toISOString())
    controller.abort()
    await running
  })
  it('fires again at the next matching minute, and not twice for one minute after a restart', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-22T00:29:30'))
    const ctx = context({ cron: '*/5 * * * *', actor: 'me', instruction: 'Check.' })
    const controller = new AbortController()
    const running = runSchedule(ctx.value, controller.signal)
    await vi.advanceTimersByTimeAsync(330_000)
    // 00:30 and 00:35.
    expect(ctx.receive).toHaveBeenCalledTimes(2)
    controller.abort()
    await running
    // A restart a few seconds after the 00:35 firing does not fire it again.
    const again = context({ cron: '*/5 * * * *', actor: 'me', instruction: 'Check.' }, ctx.state.last)
    vi.setSystemTime(new Date('2026-11-22T00:35:20'))
    const second = new AbortController()
    const looping = runSchedule(again.value, second.signal)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(again.receive).not.toHaveBeenCalled()
    second.abort()
    await looping
  })
  it('waits quietly until an account and an instruction are configured', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-22T00:29:00'))
    const ctx = context({ cron: '* * * * *', actor: '', instruction: '' })
    const controller = new AbortController()
    const running = runSchedule(ctx.value, controller.signal)
    await vi.advanceTimersByTimeAsync(180_000)
    expect(ctx.receive).not.toHaveBeenCalled()
    expect(ctx.report).toHaveBeenCalledWith('schedule', { state: 'ready', detail: 'Waiting for a requesting account and an instruction' })
    controller.abort()
    await running
  })
})
