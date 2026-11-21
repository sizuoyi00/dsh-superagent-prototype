/** The 企信 Source's message mapping: text, thread, addressed, own messages, and one id per message version. */
import { describe, expect, it, vi } from 'vitest'
import type { Trigger } from '../src/core/index.ts'
import { imConversation, imKind, imWatched, runIm } from '../src/sources/im.ts'
import { imAddressed, imOwn, imThreadId, imTrigger, imTriggerId, imText, ImMessageSchema, ImSessionSchema } from '../src/sources/im-trigger.ts'

const self = { id: 9766, name: '斯作益seth' }
const session = ImSessionSchema.parse({ sessionId: 's1', sessionName: '团队群', sessionCategory: 'T', participants: [] })
const direct = ImSessionSchema.parse({ sessionId: 's2', sessionCategory: 'D', participants: [] })
const message = (fields: Record<string, unknown> = {}) => ImMessageSchema.parse({ messageId: 10, senderId: 42, senderName: '张三',
  messageTime: 1795200000000, messageType: 'T', content: '帮我看下这个报错', ...fields })

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
    expect(imAddressed(message({ replyMessageVo: { messageId: 5, senderId: 9766 } }), session, self)).toBe('direct')
    expect(imAddressed(message(), direct, self)).toBe('direct')
  })
  it('is not addressed in a group without a mention or quote of the agent', () => {
    expect(imAddressed(message(), session, self)).toBeUndefined()
    expect(imAddressed(message({ replyMessageVo: { messageId: 5, senderId: 7 } }), session, self)).toBeUndefined()
  })
})

describe('threads and ids', () => {
  it('anchors a quoting message to the message it quotes', () => {
    expect(imThreadId(session, message())).toBe('s1:10')
    expect(imThreadId(session, message({ replyMessageVo: { messageId: 5, senderId: 7 } }))).toBe('s1:5')
  })
  it('gives one id per message version, so an edit is a new Trigger and a repoll is not', () => {
    expect(imTriggerId(message())).toBe(imTriggerId(message()))
    expect(imTriggerId(message({ messageVersion: 2 }))).not.toBe(imTriggerId(message({ messageVersion: 1 })))
  })
})

describe('the Trigger one message builds', () => {
  it('carries the sender, the chat, the quoted message, and whether it was addressed', () => {
    const trigger = imTrigger(session, message({ replyMessageVo: { messageId: 5, senderId: 7 }, content: '@斯作益seth 看一下' }), self)
    expect(trigger).toMatchObject({ source: 'im', human: true, addressed: 'mention', text: '@斯作益seth 看一下',
      actor: { source: 'im', id: '42', name: '张三' }, threads: [{ source: 'im', id: 's1:5' }],
      channel: { source: 'im', thread: 'im:s1:5', address: { sessionId: 's1', messageId: '10' } } })
    expect(trigger.meta).toMatchObject({ sessionId: 's1', messageId: 10, direct: false, quoted: 5, quotedSender: 7 })
  })
  it('marks a bot sender as not human, so Eval gates it as a machine message', () => {
    expect(imTrigger(session, message({ fullSenderId: 'BOT.360.fs_1', senderId: 7 }), self).human).toBe(false)
    expect(imTrigger(session, message(), self).human).toBe(true)
  })
})

describe('own messages', () => {
  it('drops what the agent itself sent', () => {
    expect(imOwn(message({ senderId: self.id }), self)).toBe(true)
    expect(imOwn(message(), self)).toBe(false)
  })
})

describe('the loop', () => {
  /** A context whose CLI answers from canned pages, so the loop's cursor and filtering can be checked without 企信. */
  function context(pages: Record<string, unknown[]>, config: Record<string, unknown>, state = new Map<string, number>()) {
    const receive = vi.fn(async (_trigger: Trigger) => ({ result: 'received' as const }))
    const report = vi.fn()
    const commands = { run: vi.fn(async (_program: string, args: string[]) => {
      if (args[0] === 'auth') return JSON.stringify({ userId: 9766, userName: '斯作益seth' })
      if (args[0] === 'im' && args[1] === 'session') return JSON.stringify({ sessions: [{ sessionId: 's1', sessionName: '团队群', sessionCategory: 'T', participants: [], lastMessageTime: 1000 }] })
      return JSON.stringify({ messages: pages[args[4]!] ?? [] })
    }) }
    const value = { ready: Promise.resolve(), config: () => config, report, commands,
      state: { get: (key: string) => state.get(key), set: (key: string, value: number) => { state.set(key, value) }, keys: () => [] },
      threads: { describe: vi.fn() }, receive } as unknown as Parameters<typeof runIm>[0]
    return { value, receive, report, state }
  }
  const config = { chats: [{ sessionId: 's1', listen: 'mentions' as const }], directMessages: false, pollSeconds: 10, readPageSize: 50 }
  it('starts from the newest message time and ingests nothing on the first look', async () => {
    vi.useFakeTimers()
    const ctx = context({ s1: [] }, config)
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
    const ctx = context({ s1: [
      { messageId: 13, senderId: 42, messageTime: 1300, messageType: 'T', content: '@斯作益seth 三' },
      { messageId: 12, senderId: 9766, messageTime: 1200, messageType: 'T', content: '二' },
      { messageId: 11, senderId: 42, messageTime: 1100, messageType: 'T', content: '一' },
    ] }, config, new Map([['im-cursor:s1', 1050]]))
    const controller = new AbortController()
    const running = runIm(ctx.value, controller.signal)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(ctx.receive.mock.calls.map(call => call[0].text)).toEqual(['一', '@斯作益seth 三'])
    expect(ctx.state.get('im-cursor:s1')).toBe(1300)
    controller.abort(); await running
    vi.useRealTimers()
  })
})

describe('which sessions are received', () => {
  const base = { chats: [], directMessages: false, otherChats: 'none' as const, pollSeconds: 30, readPageSize: 50 }
  const group = ImSessionSchema.parse({ sessionId: 'g1', sessionCategory: 'T', participants: [] })
  const one = ImSessionSchema.parse({ sessionId: 'd1', sessionCategory: 'D', participants: [] })
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
    const config = { chats: [], directMessages: true, otherChats: 'mentions' as const, pollSeconds: 30, readPageSize: 50 }
    expect(imConversation(oss)).toBe(false)
    expect(imWatched(oss, config)).toBe(false)
  })
})
