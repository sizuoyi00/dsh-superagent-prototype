/** The RTC payload a 企信 reply goes out as: a markdown body, hidden header and footer, the reply target, and a group @. */
import { describe, expect, it, vi } from 'vitest'
import type { OutboundMessage } from '../src/core/index.ts'
import { imKind, rtcPayload } from '../src/sources/im.ts'

const payload = (text: string, replyTo?: string, mention?: string) => rtcPayload(text, 'S1', 'E.fs.9766', replyTo, mention)
const body = (text: string) => JSON.parse(JSON.parse(payload(text).messageContent).body.content)

describe('the RTC reply payload', () => {
  it('carries the text as one markdown node, so paragraphs stay apart', () => {
    const node = body('**结论**\n\n第二段。\n\n第三段。')
    expect(node.type).toBe('doc')
    expect(node.content).toHaveLength(1)
    expect(node.content[0]).toMatchObject({ type: 'text', supportMarkdown: true, text: '**结论**\n\n第二段。\n\n第三段。' })
  })
  it('names the session, the sender and the message it answers', () => {
    expect(payload('x')).toMatchObject({ sessionId: 'S1', messageType: 'RTC', env: 0, 'authInfo.employeeId': 'E.fs.9766' })
    expect(payload('x')).not.toHaveProperty('replyMessageId')
    expect(payload('x', '402840051')).toMatchObject({ replyMessageId: 402840051 })
  })
  it('@s the person who wrote the question in a group, and only there', () => {
    expect(payload('x', '402840051', 'E.fs.42')).toMatchObject({ replyMessageId: 402840051, mentionAtFullUserIdList: ['E.fs.42'] })
    expect(payload('x', '402840051')).not.toHaveProperty('mentionAtFullUserIdList')
  })
  it('hides the header and footer, so the card shows only the message', () => {
    const rtc = JSON.parse(payload('x').messageContent)
    expect(rtc.header.hide).toBe(true)
    expect(rtc.footer.hide).toBe(true)
    expect(rtc.version).toBe('V2')
  })
})

/** A reply may carry files: the channel uploads each and sends it before the text. */
import { readFileSync as readSource } from 'node:fs'
import { expect as expectCode, it as itCode } from 'vitest'
itCode('uploads each attachment and sends it before the text', () => {
  const source = readSource(new URL('../src/sources/im.ts', import.meta.url), 'utf8')
  expectCode(source).toContain("['file', 'upload', '--file', file.path]")
  expectCode(source).toContain("'send-file', '--sessionId', sessionId, '--path', uploaded.path, '--fileName', file.name")
  expectCode(source.indexOf("send-file")).toBeLessThan(source.indexOf("'im', 'message', 'send'"))
})

/** The channel sends what the reply's address recorded: the message it answers and the person a group reply @s. */
itCode('sends the questioned message as the reply target and @s its author in a group', async () => {
  const run = vi.fn(async (_program: string, args: string[]) => args[0] === 'auth' ? JSON.stringify({ userId: 9766 }) : '{}')
  const send = (address: Record<string, string>) => imKind.channel!.send({ commands: { run } } as never,
    { id: `reply-${address.messageId}`, kind: 'reply', text: '好了', channel: { source: 'im', thread: 'im:s1:5', address } } as OutboundMessage)
  const sent = () => run.mock.calls.map(([, args]) => args).filter(args => args[0] === 'im' && args[2] === 'send')
  const sentPayload = () => { const args = sent().at(-1)!; return JSON.parse(args[args.indexOf('--data') + 1]!) as Record<string, unknown> }
  await send({ sessionId: 's1', messageId: '10', mention: 'E.fs.42' })
  // The thread is anchored to message 5, but the reply quotes message 10, the question the person wrote.
  expect(sentPayload()).toMatchObject({ sessionId: 's1', replyMessageId: 10, mentionAtFullUserIdList: ['E.fs.42'] })
  // A private chat needs no mention.
  await send({ sessionId: 's2', messageId: '11' })
  expect(sentPayload()).toMatchObject({ sessionId: 's2', replyMessageId: 11 })
  expect(sentPayload()).not.toHaveProperty('mentionAtFullUserIdList')
})
