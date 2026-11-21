/** 企信 (ShareCRM IM) Source: polls configured sessions and turns their messages into Triggers, and replies through the same CLI. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { type OutboundMessage, type Trigger } from '../core/index.ts'
import { CliError, validItems } from '../infra/commands.ts'
import { checkedImText } from '../infra/text.ts'
import { KV } from '../kv.ts'
import { sourceContext, type SourceContext } from './host.ts'
import { imQuote, imText, imTrigger, imThreadId, ImMessageSchema, ImSessionSchema, SOURCE, type ImMessage, type ImSelf } from './im-trigger.ts'
import type { ContextMessage, SourceKind } from './kind.ts'
import { pause } from './poll.ts'

/** The 企信 CLI every call goes through; it is on the service's PATH and signed in as the agent's own account. */
export const CLI = 'sharecrm'
/** How long the loop sleeps before rereading its configuration when it is not polling. */
const RECHECK_MS = 60_000
/** How many descending pages one session may take per round, so a burst cannot hold the loop. */
const MAX_PAGES = 10

const ConfigSchema = z.object({
  chats: z.array(z.object({ sessionId: z.string().trim().min(1), name: z.string().trim().max(100).optional(),
    listen: z.enum(['mentions', 'all']).default('mentions') }).strict()).default([]),
  directMessages: z.boolean().default(false),
  selfName: z.string().trim().max(100).default(''),
  otherChats: z.enum(['none', 'mentions']).default('none'),
  pollSeconds: z.number().int().min(10).max(3600).default(45),
  readPageSize: z.number().int().min(1).max(200).default(50),
}).strict()
export type ImConfig = z.infer<typeof ConfigSchema>
/** Reads the agent's own 企信 identity, so its own messages are dropped and mentions of it are recognized. */
const SelfSchema = z.looseObject({ userId: z.union([z.string(), z.number()]), userName: z.string().nullish() })
export async function readSelf(commands: SourceContext['commands'], configured?: string): Promise<ImSelf> {
  const self = SelfSchema.parse(JSON.parse(await commands.run(CLI, ['auth', 'status'])))
  const id = Number(self.userId)
  // A person's full sender id is `E.fs.<id>`; the names are what a mention in a message's text looks like.
  return { id, fullId: `E.fs.${id}`, names: [...new Set([configured?.trim(), self.userName, String(id)].filter((name): name is string => !!name))] }
}
const SessionsSchema = z.looseObject({ sessions: z.array(z.unknown()).default([]) })
/** The user's recently changed sessions; the Source polls only those it is configured for. */
export async function recentSessions(commands: SourceContext['commands']): Promise<z.infer<typeof ImSessionSchema>[]> {
  const listed = SessionsSchema.parse(JSON.parse(await commands.run(CLI, ['im', 'session', 'get-recent-list'])))
  return validItems(ImSessionSchema, listed.sessions)
}
const MessagesSchema = z.looseObject({ messages: z.array(z.unknown()).default([]) })
/** One page of a session's messages, newest first, before `fromMessageId` when given. */
export async function listMessages(commands: SourceContext['commands'], sessionId: string, num: number, fromMessageId?: number): Promise<ImMessage[]> {
  const args = ['im', 'message', 'list', '--sessionId', sessionId, '--num', String(num)]
  if (fromMessageId !== undefined) args.push('--fromMessageId', String(fromMessageId))
  const page = MessagesSchema.parse(JSON.parse(await commands.run(CLI, args)))
  return validItems(ImMessageSchema, page.messages)
}
/** Whether the Source receives this session: a configured chat, or any direct chat when direct messages are on. */
/** Only a group or a direct chat is a conversation people address the agent in; system channels are never read. */
export const imConversation = (session: z.infer<typeof ImSessionSchema>): boolean =>
  session.sessionCategory === 'T' || session.sessionCategory === 'D'
export const imWatched = (session: z.infer<typeof ImSessionSchema>, config: ImConfig): boolean => imConversation(session)
  && (config.chats.some(chat => chat.sessionId === session.sessionId)
    || (session.sessionCategory === 'D' ? config.directMessages : config.otherChats === 'mentions'))
/** The rule the configured chats give this session, when it is one of them. */
const chatRule = (sessionId: string, config: ImConfig) => config.chats.find(chat => chat.sessionId === sessionId)

export const imKind: SourceKind<ImConfig> = {
  kind: SOURCE,
  title: { zh: '企信', en: 'ShareCRM IM' },
  description: { zh: '轮询下列企信会话与私聊，把消息交给评估；回话也走同一个 CLI，以 AI 身份发出。',
    en: 'Polls these ShareCRM IM sessions and direct chats, hands their messages to Eval, and replies through the same CLI as the AI identity.' },
  schema: ConfigSchema,
  fields: [
    { key: 'chats', type: 'rows', label: { zh: '接收的会话', en: 'Sessions' },
      hint: { zh: '“仅 @”只把 @ 智能体或引用其消息的消息当作点名；“全部消息”还接收其余消息，评估可以按规则从中推断工作。',
        en: '"@ only" treats a mention of the agent, or a quote of its message, as addressed; "All" also receives the rest, from which Eval may infer work under the rules.' },
      columns: [
        { key: 'sessionId', type: 'text', label: { zh: '会话 ID', en: 'Session ID' }, pattern: '[A-Za-z0-9_-]{1,64}' },
        { key: 'name', type: 'text', label: { zh: '名称', en: 'Name' }, optional: true },
        { key: 'listen', type: 'select', label: { zh: '接收', en: 'Receive' }, options: [
          { value: 'mentions', label: { zh: '仅 @', en: '@ only' } }, { value: 'all', label: { zh: '全部消息', en: 'All' } }] },
      ] },
    { key: 'directMessages', type: 'switch', label: { zh: '接收私聊', en: 'Direct messages' } },
    { key: 'selfName', type: 'text', advanced: true, label: { zh: '我在企信里的显示名', en: 'My display name in 企信' },
      hint: { zh: '群里的 @ 只有文字，没有结构化的用户 ID，所以按这个名字识别“@我”。留空时会从自己发出的消息里学习。',
        en: 'A mention in a group is text only, without a structured user ID, so this name is what "@ me" matches. Left empty, the Source learns it from messages it sent.' } },
    { key: 'otherChats', type: 'select', label: { zh: '其他会话', en: 'Other sessions' }, options: [
      { value: 'none', label: { zh: '不接收', en: 'Not received' } }, { value: 'mentions', label: { zh: '仅 @', en: '@ only' } }],
      hint: { zh: '没有列在上面的会话（含以后新建的）。“仅 @”接收那里 @ 智能体或引用其消息的消息；谁能发起工作仍由策略里的准入决定。',
        en: 'Sessions not listed above, including ones created later. "@ only" receives messages there that mention the agent or quote it; whose messages may originate work is still the Policy\'s admission.' } },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 10, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' } },
    { key: 'readPageSize', type: 'number', advanced: true, min: 1, max: 200, label: { zh: '每页消息数', en: 'Messages per page' },
      hint: { zh: '智能体读取上下文与每轮拉取时每页的消息数。', en: 'Messages per page when agents read context and when a round fetches messages.' } },
  ],
  health: ['im'],
  scope({ meta }, config) {
    const sessionId = String(meta.sessionId ?? '')
    if (meta.direct === true) return config.directMessages ? { listened: true, observed: false, row: 'direct' } : { listened: false, reason: 'direct_messages_not_allowed' }
    const chat = chatRule(sessionId, config)
    if (chat) return { listened: true, observed: chat.listen === 'all', row: sessionId }
    return config.otherChats === 'mentions' ? { listened: true, observed: false, row: 'other' } : { listened: false, reason: 'session_not_allowed' }
  },
  channel: {
    // A reply goes only to a session the Source still receives.
    allowed: (address, config) => imKind.scope!({ meta: { sessionId: address.sessionId ?? '', direct: address.direct === 'true' } }, config).listened,
    async send(host, message: OutboundMessage) {
      const { sessionId, messageId } = message.channel.address
      if (!sessionId) throw new Error('Missing 企信 reply target')
      const args = ['im', 'message', 'send-txt', '--sessionId', sessionId, '--text', checkedImText(message.text), '--markdownFormat', 'true']
      if (messageId) args.push('--replyMessageId', messageId)
      try { await host.commands.run(CLI, args) }
      catch (error) {
        // A recalled message, a session the agent left, or a message it may no longer see: the reply can never arrive.
        if (error instanceof CliError && /not found|不存在|无权限|forbidden/i.test(error.message)) return 'gone'
        throw error
      }
      return 'sent'
    },
    link: address => ({ url: '', label: { zh: '企信会话', en: 'IM session' }, ...address.messageId ? { triggerId: imTriggerIdOf(address.messageId) } : {} }),
  },
  threadContext: {
    messageId: trigger => String(trigger.meta.messageId ?? ''),
    async read(commands, trigger: Trigger, part, cursor, config) {
      const sessionId = String(trigger.meta.sessionId ?? '')
      if (!sessionId) throw new Error('An IM source trigger is required')
      const page = await listMessages(commands, sessionId, config.readPageSize, cursor ? Number(cursor) : undefined)
      const messages = page.map(imContextMessage).reverse()
      const next = page.length >= config.readPageSize ? String(page.at(-1)!.messageId) : undefined
      return { messages: part === 'root' ? messages.filter(item => item.id === String(trigger.meta.messageId)) : messages,
        next, body: { sessionId, part, count: messages.length }, status: 'available' }
    },
  },
  policy: {
    unnamed: { person: { zh: '企信用户', en: 'IM user' }, bot: { zh: '企信机器人', en: 'IM bot' } },
    schema: z.object({
      allowed: z.array(z.object({ id: z.string().regex(/^\d{1,20}$/), name: z.string().trim().max(100).optional() }).strict())
        .refine(people => new Set(people.map(person => person.id)).size === people.length, 'Duplicate user IDs').default([]),
    }).strict(),
    fields: [
      { key: 'allowed', type: 'rows', label: { zh: '能发起工作的企信用户', en: 'IM users who may originate work' },
        columns: [{ key: 'id', type: 'text', label: { zh: '用户 ID', en: 'User ID' }, pattern: '[0-9]{1,20}' },
          { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] },
    ],
    explicit: { zh: '名单内的人 @ 智能体或私聊它，总是明确的请求；引用智能体消息也算点名。',
      en: 'Someone on the list who mentions the agent or messages it directly always makes an explicit request; quoting its message counts as addressed too.' },
    rows(stored) {
      const config = ConfigSchema.parse(stored)
      const mentions = { zh: '仅 @', en: '@ only' }
      return [
        ...config.chats.map(chat => ({ id: chat.sessionId, label: chat.name || chat.sessionId, note: chat.listen === 'all' ? { zh: '全部消息', en: 'All' } : mentions,
          cells: { listedUnaddressed: chat.listen === 'all', unlistedAddressed: true, unlistedUnaddressed: chat.listen === 'all' } })),
        { id: 'other', label: { zh: '其他会话', en: 'Other sessions' }, note: config.otherChats === 'mentions' ? mentions : { zh: '不接收', en: 'Not received' },
          cells: { listedUnaddressed: false, unlistedAddressed: config.otherChats === 'mentions', unlistedUnaddressed: false } },
        { id: 'direct', label: { zh: '私聊', en: 'Direct messages' }, note: config.directMessages ? { zh: '接收', en: 'Received' } : { zh: '不接收', en: 'Not received' },
          cells: { listedUnaddressed: false, unlistedAddressed: config.directMessages, unlistedUnaddressed: false } },
      ]
    },
  },
  environment: {
    variables: [{ key: 'DSH_SUPERAGENT_IM_SESSION', description: { zh: '接下工单的企信会话 ID；工单不是从企信来的时为空', en: 'Session ID of the IM chat that started the ticket; empty when it did not start on IM' } }],
    values: ({ trigger }) => ({ DSH_SUPERAGENT_IM_SESSION: trigger?.source === SOURCE ? String(trigger.meta.sessionId ?? '') : '' }),
  },
}

/** A Trigger id for a message id, so a Channel link can point back at the message it replies to. */
const imTriggerIdOf = (messageId: string): string => `${SOURCE}-message:${messageId}`
const imContextMessage = (message: ImMessage): ContextMessage => { const quote = imQuote(message)
  return { id: String(message.messageId), from: message.senderName ?? String(message.senderId),
    at: new Date(message.messageTime).toISOString(), text: imText(message), ...quote ? { reply_to: String(quote.messageId) } : {} } }

export const name = 'dsh-superagent-im'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(imKind), 'im: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, imKind)
    const controller = new AbortController()
    // Unhandled rejections terminate the DSH process, so a failure escaping the loop is reported as Source health instead.
    const running = runIm(source, controller.signal).catch((error: unknown) => { source.report('im', { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}

/** Polls the configured sessions until the signal aborts, reporting health instead of throwing. */
export async function runIm(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  let self: ImSelf | undefined
  while (!signal.aborted) {
    const config = ctx.config<ImConfig>(SOURCE)
    const report = (state: 'starting' | 'ready' | 'error', detail: string) => ctx.report('im', { state, detail })
    if (!config || (!config.chats.length && !config.directMessages && config.otherChats === 'none')) {
      report('ready', 'Waiting for a session to receive')
      await pause(RECHECK_MS, signal)
      continue
    }
    try {
      self ??= await readSelf(ctx.commands, config.selfName)
      const sessions = (await recentSessions(ctx.commands)).filter(session => imWatched(session, config))
      const failures: string[] = []
      for (const session of sessions) {
        if (signal.aborted) return
        // One unreadable session must not blind the others, so its failure is collected and the round goes on.
        try { await pollSession(ctx, config, self, session) } catch (error) { failures.push(String(error)) }
      }
      if (failures.length >= sessions.length && failures.length) report('error', failures[0]!)
      else report('ready', `Watching ${sessions.length} session(s)${failures.length ? `; ${failures.length} unreadable` : ''}; next poll in ${config.pollSeconds}s`)
    } catch (error) {
      report('error', String(error))
    }
    await pause(config.pollSeconds * 1000, signal)
  }
}

/** Ingests the messages of one session that arrived after its cursor, oldest first, then advances the cursor. */
async function pollSession(ctx: SourceContext, config: ImConfig, self: ImSelf, session: z.infer<typeof ImSessionSchema>): Promise<void> {
  const cursorKey = KV.im.cursor(session.sessionId)
  const since: number | undefined = ctx.state.get(cursorKey)
  if (since === undefined) {
    // The first look starts from now: old messages are not history the agent should answer.
    ctx.state.set(cursorKey, session.lastMessageTime ?? Date.now())
    return
  }
  const pages: ImMessage[][] = []
  let reached = false
  let from: number | undefined
  for (let page = 0; page < MAX_PAGES; page++) {
    const messages = await listMessages(ctx.commands, session.sessionId, config.readPageSize, from)
    if (!messages.length) { reached = true; break }
    pages.push(messages)
    const oldest = messages.at(-1)!
    if (messages.length < config.readPageSize || oldest.messageTime <= since) { reached = true; break }
    from = oldest.messageId
  }
  // A burst longer than one round of pages is caught up from its oldest page, so no message is skipped and the order holds.
  const window = reached ? pages.flat() : pages.at(-1) ?? []
  const ordered = window.filter(message => message.messageTime > since).sort((left, right) => left.messageTime - right.messageTime)
  for (const message of ordered) {
    if (message.senderId === self.id) {
      // The agent's own messages carry the display name people mention; learning it makes "@ me" work.
      if (message.senderName && !self.names.includes(message.senderName)) self.names.push(message.senderName)
      continue
    }
    const trigger = imTrigger(session, message, self)
    ctx.threads.describe(`${SOURCE}:${imThreadId(session, message)}`, { label: session.sessionName ?? session.sessionId })
    await ctx.receive(trigger)
  }
  if (ordered.length) ctx.state.set(cursorKey, ordered.at(-1)!.messageTime)
}
