/** The RTC payload a 企信 reply goes out as: a markdown body, hidden header and footer, and the reply target. */
import { describe, expect, it } from 'vitest'
import { rtcPayload } from '../src/sources/im.ts'

const payload = (text: string, replyTo?: string) => rtcPayload(text, 'S1', 'E.fs.9766', replyTo)
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
