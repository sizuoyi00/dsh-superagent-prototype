/** The 企信 Source's message mapping: text, thread, addressed, own messages, and one id per message version. */
import { describe, expect, it, vi } from 'vitest'
import type { Trigger } from '../src/core/index.ts'
import { imConversation, imKind, imWatched, runIm } from '../src/sources/im.ts'
import { imAddressed, imDirect, imOwn, imThreadId, imTrigger, imTriggerId, imText, ImMessageSchema, ImSessionSchema } from '../src/sources/im-trigger.ts'

const self = { id: 9766, fullId: 'E.fs.9766', names: ['斯作益seth'] }
const session = ImSessionSchema.parse({ sessionId: 's1', sessionName: '团队群', sessionCategory: 'T', participants: [] })
const direct = ImSessionSchema.parse({ sessionId: 's2', sessionCategory: 'S', participants: [] })
const message = (fields: Record<string, unknown> = {}) => ImMessageSchema.parse({ messageId: 10, senderId: 42, senderName: '张三',
  messageTime: 1795200000000, messageType: 'T', content: '帮我看下这个报错', ...fields })

/** A context whose CLI answers from canned pages, so the loop's cursor and filtering can be checked without 企信. */
function loopContext(pages: Record<string, unknown[]>, config: Record<string, unknown>, state = new Map<string, number>()) {
  const receive = vi.fn(async (_trigger: Trigger) => ({ result: 'received' as const }))
  const report = vi.fn()
  const commands = { run: vi.fn(async (_program: string, args: string[]) => {
    if (args[0] === 'auth') return JSON.stringify({ userId: 9766, userName: '斯作益seth' })
    if (args[0] === 'im' && args[1] === 'session') return JSON.stringify({ sessions: [{ sessionId: 's1', sessionName: '团队群', sessionCategory: 'D', participants: [], lastMessageTime: 1000 }] })
    return JSON.stringify({ messages: pages[args[4]!] ?? [] })
  }) }
  const value = { ready: Promise.resolve(), config: () => config, report, commands,
    state: { get: (key: string) => state.get(key), set: (key: string, value: number) => { state.set(key, value) }, keys: () => [] },
    threads: { describe: vi.fn() }, receive } as unknown as Parameters<typeof runIm>[0]
  return { value, receive, report, state }
}

describe('what a message says', () => {
  it('keeps text as written and names a message without text by its type', () => {
    expect(imText(message())).toBe('帮我看下这个报错')
    expect(imText(message({ messageType: 'I', content: '{"url":"x"}' }))).toBe('[图片]')
    expect(imText(message({ messageType: 'Z', content: null }))).toBe('[Z]')
  })
})

describe('what a message is addressed to', () => {
  it('is addressed when it mentions the agent, quotes it, or is a direct chat', () => {
    expect(imAddressed(message({ content: '@斯作益seth 这个怎么处理' }), session, self)).toBe('mention')
    expect(imAddressed(message({ replyMessageVo: { messageId: 5, fullSenderId: 'E.fs.9766' } }), session, self)).toBe('direct')
    expect(imAddressed(message(), direct, self)).toBe('direct')
  })
  it('is not addressed in a group without a mention or quote of the agent', () => {
    expect(imAddressed(message(), session, self)).toBeUndefined()
    expect(imAddressed(message({ replyMessageVo: { messageId: 5, fullSenderId: 'E.fs.7' } }), session, self)).toBeUndefined()
  })
  it('does not treat the account\'s own words as a request unless they name the agent', () => {
    const own = message({ senderId: self.id })
    expect(imAddressed(own, direct, self)).toBeUndefined()
    expect(imAddressed(own, session, self)).toBeUndefined()
    expect(imAddressed(message({ senderId: self.id, content: '@斯作益seth 看一下' }), direct, self)).toBe('mention')
    expect(imAddressed(message({ senderId: self.id, replyMessageVo: { messageId: 5, fullSenderId: 'E.fs.9766' } }), direct, self)).toBe('direct')
  })
})

describe('threads and ids', () => {
  it('anchors a quoting message to the message it quotes', () => {
    expect(imThreadId(session, message())).toBe('s1:10')
    expect(imThreadId(session, message({ replyMessageVo: { messageId: 5, fullSenderId: 'E.fs.7' } }))).toBe('s1:5')
  })
  it('gives one id per message version, so an edit is a new Trigger and a repoll is not', () => {
    expect(imTriggerId(message())).toBe(imTriggerId(message()))
    expect(imTriggerId(message({ messageVersion: 2 }))).not.toBe(imTriggerId(message({ messageVersion: 1 })))
  })
})

describe('the Trigger one message builds', () => {
  it('carries the sender, the chat, the quoted message, and whether it was addressed', () => {
    const trigger = imTrigger(session, message({ replyMessageVo: { messageId: 5, fullSenderId: 'E.fs.7' }, content: '@斯作益seth 看一下' }), self)
    expect(trigger).toMatchObject({ source: 'im', human: true, addressed: 'mention', text: '@斯作益seth 看一下',
      actor: { source: 'im', id: '42', name: '张三' }, threads: [{ source: 'im', id: 's1:5' }],
      channel: { source: 'im', thread: 'im:s1:5', address: { sessionId: 's1', messageId: '10' } } })
    expect(trigger.meta).toMatchObject({ sessionId: 's1', messageId: 10, direct: false, quoted: 5, quotedSender: 'E.fs.7' })
  })
  it('marks a bot sender as not human, so Eval gates it as a machine message', () => {
    expect(imTrigger(session, message({ fullSenderId: 'BOT.360.fs_1', senderId: 7 }), self).human).toBe(false)
    expect(imTrigger(session, message(), self).human).toBe(true)
  })
  it('quotes the question itself, not the topic it was posted under, and @s its author in a group', () => {
    const trigger = imTrigger(session, message({ replyMessageVo: { messageId: 5, fullSenderId: 'E.fs.7' }, fullSenderId: 'E.fs.42' }), self)
    expect(trigger.threads[0]!.id).toBe('s1:5')
    expect(trigger.channel!.address).toEqual({ sessionId: 's1', messageId: '10', mention: 'E.fs.42' })
  })
  it('does not @ anyone in a private chat, or on a message a bot or the account itself wrote', () => {
    expect(imTrigger(direct, message({ fullSenderId: 'E.fs.42' }), self).channel!.address).toEqual({ sessionId: 's2', messageId: '10' })
    expect(imTrigger(session, message({ fullSenderId: 'BOT.360.fs_1', senderId: 7 }), self).channel!.address).toEqual({ sessionId: 's1', messageId: '10' })
    expect(imTrigger(session, message({ senderId: self.id, fullSenderId: 'E.fs.9766' }), self).channel!.address).toEqual({ sessionId: 's1', messageId: '10' })
  })
  it('names a sender without a full id by the internal employee form 企信 uses', () => {
    expect(imTrigger(session, message(), self).channel!.address).toEqual({ sessionId: 's1', messageId: '10', mention: 'E.fs.42' })
  })
})

describe('own messages', () => {
  it('drops only what the AI send path produced, and answers what the person typed in their own client', () => {
    expect(imOwn(message({ senderId: self.id, tagFromLabel: '本内容由 ShareAgent 生成' }), self)).toBe(true)
    expect(imOwn(message({ senderId: self.id }), self)).toBe(false)
    expect(imOwn(message(), self)).toBe(false)
  })
})

describe('the loop', () => {
  const config = { chats: [{ sessionId: 's1', listen: 'mentions' as const }], directMessages: false, pollSeconds: 10, quietSeconds: 0, readPageSize: 50 }
  it('starts from the newest message time and ingests nothing on the first look', async () => {
    vi.useFakeTimers()
    const ctx = loopContext({ s1: [] }, config)
    const controller = new AbortController()
    const running = runIm(ctx.value, controller.signal)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(ctx.state.get('im-cursor:s1')).toBe(1000)
    expect(ctx.receive).not.toHaveBeenCalled()
    controller.abort(); await running
    vi.useRealTimers()
  })
  it('ingests messages after the cursor oldest first, skips its own, and advances the cursor', async () => {
    vi.useFakeTimers()
    const ctx = loopContext({ s1: [
      { messageId: 14, senderId: 9766, messageTime: 1250, messageType: 'T', content: '我自己说的一句' },
      { messageId: 13, senderId: 42, messageTime: 1300, messageType: 'T', content: '@斯作益seth 三' },
      { messageId: 12, senderId: 9766, messageTime: 1200, messageType: 'T', content: '二', tagFromLabel: '本内容由 ShareAgent 生成' },
      { messageId: 11, senderId: 42, messageTime: 1100, messageType: 'T', content: '一' },
    ] }, config, new Map([['im-cursor:s1', 1050]]))
    const controller = new AbortController()
    const running = runIm(ctx.value, controller.signal)
    await vi.advanceTimersByTimeAsync(20_000)
    // The person's own words to the group are not requests, what the agent already sent is skipped, and the first
    // message is left to the person because they spoke after it.
    expect(ctx.receive.mock.calls.map(call => call[0].text)).toEqual(['@斯作益seth 三'])
    expect(ctx.state.get('im-cursor:s1')).toBe(1300)
    controller.abort(); await running
    vi.useRealTimers()
  })
  it('leaves a message alone once the person has answered the session, and still takes one that came after their reply', async () => {
    vi.useFakeTimers()
    const ctx = loopContext({ s1: [
      { messageId: 23, senderId: 42, messageTime: 1300, messageType: 'T', content: '这个你看下' },
      { messageId: 22, senderId: 42, messageTime: 1200, messageType: 'T', content: '帮我合下代码' },
      { messageId: 21, senderId: 9766, messageTime: 1250, messageType: 'T', content: '我来', senderName: '斯作益seth' },
    ] }, config, new Map([['im-cursor:s1', 1050]]))
    const controller = new AbortController()
    const running = runIm(ctx.value, controller.signal)
    await vi.advanceTimersByTimeAsync(20_000)
    // The person answered the first message themselves; the second arrived after their reply.
    expect(ctx.receive.mock.calls.map(call => call[0].text)).toEqual(['这个你看下'])
    controller.abort(); await running
    vi.useRealTimers()
  })
})

describe('which sessions are received', () => {
  const base = { chats: [], directMessages: false, otherChats: 'none' as const, selfName: '', aliases: '', pollSeconds: 30, quietSeconds: 0, readPageSize: 50 }
  const group = ImSessionSchema.parse({ sessionId: 'g1', sessionCategory: 'D', participants: [] })
  const one = ImSessionSchema.parse({ sessionId: 'd1', sessionCategory: 'S', participants: [] })
  it('receives nothing until a session, direct chats or other sessions are switched on', async () => {
    expect(imWatched(group, base)).toBe(false)
    expect(imWatched(one, base)).toBe(false)
    expect(imKind.scope!({ meta: { sessionId: 'g1', direct: false } }, base)).toMatchObject({ listened: false })
  })
  it('receives every unlisted session when other sessions are on, and every direct chat when they are on', async () => {
    const all = { ...base, otherChats: 'mentions' as const }
    expect(imWatched(group, all)).toBe(true)
    expect(imKind.scope!({ meta: { sessionId: 'g1', direct: false } }, all)).toMatchObject({ listened: true, observed: false, row: 'other' })
    expect(imWatched(one, { ...base, directMessages: true })).toBe(true)
    expect(imKind.scope!({ meta: { sessionId: 'd1', direct: true } }, { ...base, directMessages: true })).toMatchObject({ listened: true, row: 'direct' })
  })
})

describe('system channels', () => {
  it('never reads a system channel, even with other sessions on', () => {
    const oss = ImSessionSchema.parse({ sessionId: 'OSS1.publish.1', sessionCategory: 'OSS1', participants: [] })
    const config = { chats: [], directMessages: true, otherChats: 'mentions' as const, selfName: '', aliases: '', pollSeconds: 30, quietSeconds: 0, readPageSize: 50 }
    expect(imConversation(oss)).toBe(false)
    expect(imWatched(oss, config)).toBe(false)
  })
})

describe('a burst longer than one round of pages', () => {
  it('catches up from the oldest page, so nothing is skipped and the order holds', async () => {
    vi.useFakeTimers()
    // Twelve messages, one per page, from time 1100 to 2200; the cursor sits at 1000.
    const burst = Array.from({ length: 12 }, (_value, index) => ({ messageId: 100 + index, senderId: 42,
      messageTime: 1100 + index * 100, messageType: 'T', content: `m${index}` }))
    const ctx = loopContext({}, { chats: [{ sessionId: 's1', listen: 'mentions' as const }], directMessages: false,
      otherChats: 'none' as const, selfName: '', aliases: '', pollSeconds: 10, quietSeconds: 0, readPageSize: 1 }, new Map([['im-cursor:s1', 1000]]))
    // A page holds the message just older than its cursor, as 企信 returns them newest first.
    ctx.value.commands.run = vi.fn(async (_program: string, args: string[]) => {
      if (args[0] === 'auth') return JSON.stringify({ userId: 9766, userName: '斯作益seth' })
      if (args[0] === 'im' && args[1] === 'session') return JSON.stringify({ sessions: [{ sessionId: 's1', sessionCategory: 'D', participants: [], lastMessageTime: 1000 }] })
      const from = args.includes('--fromMessageId') ? args[args.indexOf('--fromMessageId') + 1]! : ''
      if (!from) return JSON.stringify({ messages: [burst.at(-1)] })
      const index = burst.findIndex(message => String(message.messageId) === from)
      return JSON.stringify({ messages: index > 0 ? [burst[index - 1]] : [] })
    })
    const controller = new AbortController()
    const running = runIm(ctx.value, controller.signal)
    await vi.advanceTimersByTimeAsync(1_000)
    // The ten pages end at m2: only that oldest page is ingested, and the cursor follows it rather than the newest message.
    expect(ctx.receive.mock.calls.map(call => call[0].text)).toEqual(['m2'])
    expect(ctx.state.get('im-cursor:s1')).toBe(1300)
    // The next round catches up with the rest, still in order.
    await vi.advanceTimersByTimeAsync(11_000)
    expect(ctx.receive.mock.calls.map(call => call[0].text)).toEqual(['m2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9', 'm10', 'm11'])
    controller.abort(); await running
    vi.useRealTimers()
  })
})

describe('session kinds', () => {
  it('receives groups and direct chats only, and treats only a direct chat as addressed on its own', () => {
    const group = ImSessionSchema.parse({ sessionId: 'g', sessionCategory: 'D', participants: [] })
    const direct = ImSessionSchema.parse({ sessionId: 's', sessionCategory: 'S', participants: [] })
    expect(imConversation(group)).toBe(true)
    expect(imConversation(direct)).toBe(true)
    expect(imConversation(ImSessionSchema.parse({ sessionId: 'c', sessionCategory: 'C', participants: [] }))).toBe(false)
    expect(imDirect(direct)).toBe(true)
    expect(imDirect(group)).toBe(false)
  })
})

describe('mentions inside rich messages', () => {
  it('recognizes a mention in a card or rich-text message, whose visible text is a placeholder', () => {
    const card = ImMessageSchema.parse({ messageId: 30, senderId: 42, messageTime: 1795200000000, messageType: 'MIX',
      content: '{"title":"@斯作益seth 请看这个构建失败"}' })
    expect(imText(card)).toBe('[图文]')
    expect(imAddressed(card, ImSessionSchema.parse({ sessionId: 's1', sessionCategory: 'D', participants: [] }), self)).toBe('mention')
  })
})

describe('mention names', () => {
  it('matches a configured alias as well as the account name', () => {
    const group = ImSessionSchema.parse({ sessionId: 'g1', sessionCategory: 'D', participants: [] })
    const aliasSelf = { id: 9766, fullId: 'E.fs.9766', names: ['斯作益seth', 'AI分身'] }
    const message = (content: string) => ImMessageSchema.parse({ messageId: 40, senderId: 42, senderTime: 0, messageTime: 1795200000000,
      messageType: 'T', content })
    expect(imAddressed(message('@AI分身 帮我巡检一下这个群'), group, aliasSelf)).toBe('mention')
    expect(imAddressed(message('@斯作益seth 看下'), group, aliasSelf)).toBe('mention')
    expect(imAddressed(message('@AI分身'), group, { ...aliasSelf, names: ['斯作益seth'] })).toBeUndefined()
  })
})

describe('rich messages', () => {
  const rich = (elements: unknown[], messageType = 'MIX') => ImMessageSchema.parse({ messageId: 50, senderId: 42, messageTime: 1795200000000,
    messageType, content: JSON.stringify({ elements }) })
  it('reads the text a card carries, which is often the only place a request is written', () => {
    expect(imText(rich([{ type: 'I', content: '{"Image":"N_x.png"}' },
      { type: 'T', content: '以上配置未去掉1121版本变量的灰度，请确认' }])))
      .toBe('[图片]\n以上配置未去掉1121版本变量的灰度，请确认')
  })
  it('names an image without text instead of dropping the message', () => {
    expect(imText(rich([{ type: 'I', content: '{"Image":"N_x.png"}' }]))).toBe('[图片]')
    expect(imText(rich([{ type: 'I', content: '{}' }, { type: 'I', content: '{}' }]))).toBe('[图片×2]')
  })
  it('treats a card text element as addressed when it mentions the agent', () => {
    const card = rich([{ type: 'T', content: '@斯作益seth 请确认' }])
    expect(imAddressed(card, ImSessionSchema.parse({ sessionId: 'g1', sessionCategory: 'D', participants: [] }), self)).toBe('mention')
  })
})

describe('bot conversations', () => {
  const bot = ImSessionSchema.parse({ sessionId: 'b1', sessionCategory: 'BOT', participants: [] })
  const config = { chats: [], directMessages: true, otherChats: 'none' as const, selfName: '', aliases: '', pollSeconds: 45, quietSeconds: 0, readPageSize: 50 }
  it('are read like a direct chat, so an instruction typed there reaches the agent', () => {
    expect(imConversation(bot)).toBe(true)
    expect(imWatched(bot, config)).toBe(true)
    expect(imDirect(bot)).toBe(true)
    const message = ImMessageSchema.parse({ messageId: 60, senderId: 9766, messageTime: 1795200000000, messageType: 'T', content: '@AI分身 查下日志' })
    expect(imAddressed(message, bot, { id: 9766, fullId: 'E.fs.9766', names: ['斯作益seth', 'AI分身'] })).toBe('direct')
  })
  it('still ignores service channels', () => {
    expect(imConversation(ImSessionSchema.parse({ sessionId: 'o1', sessionCategory: 'OSS1', participants: [] }))).toBe(false)
    expect(imConversation(ImSessionSchema.parse({ sessionId: 'c1', sessionCategory: 'CRM', participants: [] }))).toBe(false)
  })
})
