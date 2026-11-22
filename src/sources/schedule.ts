/** Schedule Source: turns a cron expression and a fixed instruction into Triggers, so standing work needs no incoming message. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { key, threadKey, type Trigger } from '../core/index.ts'
import { family } from '../kv.ts'
import { sourceContext, type SourceContext } from './host.ts'
import type { SourceKind } from './kind.ts'
import { pause } from './poll.ts'

export const SOURCE = 'schedule'
/** How long the loop sleeps before rereading its configuration, so a saved change applies within a minute. */
const RECHECK_MS = 60_000
/** Minutes searched for the next matching time; a leap year covers every expression. */
const SEARCH_MINUTES = 366 * 24 * 60
/** The last firing minute recorded for this Source, so a restart does not replay a firing. */
const fired = family<string, [source: string]>('schedule-fired:')

/** One parsed 5-field cron expression, read in the machine's local time zone. */
export interface Cron {
  minute: Set<number>
  hour: Set<number>
  day: Set<number>
  month: Set<number>
  weekday: Set<number>
  /** Vixie semantics: with both day fields restricted a date matches either, otherwise both must match. */
  either: boolean
}
/** Parses one field: `*`, `a`, `a-b`, `*\/n`, `a-b/n`, or a comma list of those. */
function field(text: string, min: number, max: number): Set<number> {
  const values = new Set<number>()
  for (const part of text.split(',')) {
    const step = /^(.*)\/(\d+)$/.exec(part)
    const size = step ? Number(step[2]) : 1
    const body = step ? step[1]! : part
    const range = /^(\d+)-(\d+)$/.exec(body)
    const single = /^(\d+)$/.exec(body)
    const from = body === '*' ? min : range ? Number(range[1]) : single ? Number(single[1]) : NaN
    const to = body === '*' ? max : range ? Number(range[2]) : single ? Number(single[1]) : NaN
    if (!(size > 0) || !Number.isInteger(from) || !Number.isInteger(to) || from < min || to > max || from > to) {
      throw new Error(`Invalid cron field: ${part}`)
    }
    for (let value = from; value <= to; value += size) values.add(value)
  }
  return values
}
/** Parses a 5-field cron expression (`minute hour day-of-month month day-of-week`); throws when a field is invalid. */
export function parseCron(text: string): Cron {
  const parts = text.trim().split(/\s+/)
  if (parts.length !== 5) throw new Error('A cron expression has five fields: minute hour day-of-month month day-of-week')
  const ranges: [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]]
  const [minute, hour, day, month, weekday] = parts.map((part, index) => field(part, ...ranges[index]!))
  return { minute: minute!, hour: hour!, day: day!, month: month!, weekday: new Set([...weekday!].map(value => value === 7 ? 0 : value)),
    either: parts[2] !== '*' && parts[4] !== '*' }
}
/** True when the local minute of `date` matches the expression. */
const matches = (cron: Cron, date: Date): boolean => {
  const day = cron.day.has(date.getDate()), weekday = cron.weekday.has(date.getDay())
  return cron.minute.has(date.getMinutes()) && cron.hour.has(date.getHours()) && cron.month.has(date.getMonth() + 1)
    && (cron.either ? day || weekday : day && weekday)
}
/** Returns the first local minute after `from` that matches `cron`, or undefined when none matches within a year. */
export function nextFire(cron: Cron, from: Date): Date | undefined {
  const at = new Date(from.getTime())
  at.setSeconds(0, 0)
  at.setMinutes(at.getMinutes() + 1)
  for (let step = 0; step < SEARCH_MINUTES; step++) {
    if (matches(cron, at)) return new Date(at.getTime())
    at.setMinutes(at.getMinutes() + 1)
  }
  return undefined
}
const ConfigSchema = z.object({
  cron: z.string().trim().default('0 9 * * *').refine((text) => {
    try { parseCron(text); return true } catch { return false }
  }, 'A five-field cron expression such as `0 9 * * *`'),
  actor: z.string().trim().max(64).default(''),
  instruction: z.string().trim().max(2000).default(''),
}).strict()
export type ScheduleConfig = z.infer<typeof ConfigSchema>
/**
 * Builds one firing's Trigger; its ID is the firing minute, so the same minute is ingested once. Each firing gets its own
 * Thread, so a changed instruction starts a new Ticket instead of being handed to the one a previous firing opened.
 */
export function scheduleTrigger(instance: string, config: ScheduleConfig, fireAt: Date): Trigger {
  const at = fireAt.toISOString()
  return { id: key('schedule', instance, at), source: SOURCE, threads: [{ source: SOURCE, id: `${instance}:${at}` }],
    actor: { source: SOURCE, id: config.actor }, human: true, at, text: config.instruction, addressed: 'direct',
    meta: { instance, cron: config.cron, fire: at } }
}

export const scheduleKind: SourceKind<ScheduleConfig> = {
  kind: SOURCE,
  title: { zh: '定时', en: 'Schedule' },
  description: { zh: '按 cron 表达式，把一条固定的任务说明以某个账户的名义交给智能体。',
    en: 'Hands a fixed instruction to the agent on a cron schedule, in one account’s name.' },
  schema: ConfigSchema,
  fields: [
    { key: 'cron', type: 'text', label: { zh: 'cron 表达式', en: 'Cron expression' },
      hint: { zh: '五个字段：分 时 日 月 周，按本机时区。每 15 分钟写作 `*/15 * * * *`，每天 9 点写作 `0 9 * * *`。',
        en: 'Five fields: minute hour day-of-month month day-of-week, in the machine’s time zone. `*/15 * * * *` is every 15 minutes, `0 9 * * *` is 09:00 daily.' } },
    { key: 'actor', type: 'text', label: { zh: '发起账户', en: 'Requesting account' },
      hint: { zh: '每次触发都以这个账户的名义提出，它必须出现在策略中本来源的名单里，评估才会当作明确请求。',
        en: 'Each firing asks in this account’s name; it must be on this Source’s Policy list for Eval to treat it as an explicit request.' } },
    { key: 'instruction', type: 'text', label: { zh: '任务说明', en: 'Instruction' },
      hint: { zh: '每次触发交给智能体的内容，像一条人写的请求那样被评估和执行。',
        en: 'What each firing hands the agent; it is assessed and executed like a request a person wrote.' } },
  ],
  health: ['schedule'],
  policy: {
    schema: z.object({
      allowed: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_.@-]{1,64}$/), name: z.string().trim().max(100).optional() }).strict())
        .refine(accounts => new Set(accounts.map(account => account.id)).size === accounts.length, 'Duplicate accounts').default([]),
    }).strict(),
    fields: [
      { key: 'allowed', type: 'rows', label: { zh: '能发起定时工作的账户', en: 'Accounts whose schedules may originate work' },
        hint: { zh: '来源设置里的发起账户必须出现在这里，定时触发才会被当作明确请求。',
          en: 'The requesting account in the Source settings must appear here for a firing to count as an explicit request.' },
        columns: [
          { key: 'id', type: 'text', label: { zh: '账户', en: 'Account' }, pattern: '[A-Za-z0-9_.@-]{1,64}' },
          { key: 'name', type: 'text', label: { zh: '名称', en: 'Name' }, optional: true },
        ] },
    ],
    explicit: { zh: '定时触发把任务说明直接发给智能体，并以来源设置里的发起账户名义提出。',
      en: 'A schedule sends its instruction to the agent directly, in the name of the requesting account in the Source settings.' },
    unnamed: { person: { zh: '账户', en: 'Account' }, bot: { zh: '机器人', en: 'Bot' } },
  },
}

export const name = 'dsh-superagent-schedule'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(scheduleKind), 'schedule: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, scheduleKind)
    const controller = new AbortController()
    // Unhandled rejections terminate the DSH process, so a failure escaping the loop is reported as Source health instead.
    const running = runSchedule(source, controller.signal)
      .catch((error: unknown) => { source.report('schedule', { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}
/** Waits for setup, then fires the configured expression once per matching minute, remembering the last firing across restarts. */
export async function runSchedule(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  // The chosen firing is kept, so a sleep that ends inside its minute fires it instead of searching for the next one.
  let pending: { at: Date; cron: string } | undefined
  while (!signal.aborted) {
    const config = ctx.config<ScheduleConfig>(SOURCE)
    const report = (state: 'starting' | 'ready' | 'error', detail: string) => ctx.report('schedule', { state, detail })
    if (!config?.actor || !config.instruction) {
      pending = undefined
      report('ready', 'Waiting for a requesting account and an instruction')
      await pause(RECHECK_MS, signal)
      continue
    }
    if (pending && pending.cron !== config.cron) pending = undefined
    if (!pending) {
      const last = ctx.state.get(fired(SOURCE))
      const after = last ? new Date(Math.max(Date.now(), Date.parse(last) + 60_000)) : new Date()
      let at: Date | undefined
      try { at = nextFire(parseCron(config.cron), after) } catch (error) { report('error', String(error)); await pause(RECHECK_MS, signal); continue }
      if (!at) { report('error', `No firing within a year for ${config.cron}`); await pause(RECHECK_MS, signal); continue }
      pending = { at, cron: config.cron }
    }
    const wait = pending.at.getTime() - Date.now()
    if (wait > 0) {
      report('ready', `Next firing at ${pending.at.toISOString()}`)
      await pause(Math.min(wait, RECHECK_MS), signal)
      continue
    }
    const at = pending.at
    pending = undefined
    ctx.state.set(fired(SOURCE), at.toISOString())
    ctx.threads.describe(threadKey({ source: SOURCE, id: `${SOURCE}:${at.toISOString()}` }), { label: `Schedule ${config.cron} ${at.toISOString()}` })
    await ctx.receive(scheduleTrigger(SOURCE, config, at))
  }
}
