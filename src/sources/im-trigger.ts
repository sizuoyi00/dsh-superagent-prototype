/** Normalizes 企信 (ShareCRM IM) sessions and messages into domain Triggers. */
import { z } from 'zod'
import { key, type Trigger } from '../core/index.ts'

export const SOURCE = 'im'
/** A participant of a session: `E` an employee, `BOT` a bot. */
export const ImParticipantSchema = z.looseObject({ participantId: z.number(), enterpriseAccount: z.string().optional(), type: z.string() })
/** A 企信 session (a group `T`, a direct chat `D`, or a system channel such as `OSS1`). */
export const ImSessionSchema = z.looseObject({
  sessionId: z.string(),
  sessionName: z.string().nullish(),
  sessionCategory: z.string().nullish(),
  participants: z.array(ImParticipantSchema).default([]),
  lastMessageId: z.number().nullish(),
  lastMessageTime: z.number().nullish(),
})
export type ImSession = z.infer<typeof ImSessionSchema>
/** A quoted message: 企信 returns it beside the quoting message, without the quoted message's own text in some cases. */
export const ImQuoteSchema = z.looseObject({ messageId: z.number(), fullSenderId: z.string().nullish(), senderName: z.string().nullish(),
  content: z.string().nullish(), messageTime: z.number().nullish() })
/** One 企信 message; `messageType` is `T` for text and other letter codes for images, files, cards and system events. */
export const ImMessageSchema = z.looseObject({
  messageId: z.number(),
  previousMessageId: z.number().nullish(),
  senderId: z.number(),
  senderName: z.string().nullish(),
  fullSenderId: z.string().nullish(),
  messageTime: z.number(),
  messageType: z.string(),
  content: z.string().nullish(),
  messageVersion: z.number().nullish(),
  private: z.boolean().nullish(),
  replyMessageVo: ImQuoteSchema.nullish(),
  replyMessage: ImQuoteSchema.nullish(),
  quoteMessageVo: ImQuoteSchema.nullish(),
  atList: z.array(z.unknown()).nullish(),
  mentionList: z.array(z.unknown()).nullish(),
  atFullUserIdList: z.array(z.string()).nullish(),
  /** Set by the AI send path, for example `本内容由 ShareAgent 生成`; a message a person typed has none. */
  tagFromLabel: z.string().nullish(),
})
export type ImMessage = z.infer<typeof ImMessageSchema>
/** What the Source knows about its own identity, so it can drop its own messages and recognize messages addressed to it. */
export interface ImSelf { id: number; fullId: string; names: string[] }
/** Placeholder for a message type without text, so meaning is preserved without reading the payload. */
const PLACEHOLDER: Record<string, string> = { I: '[图片]', F: '[文件]', V: '[语音]', MIX: '[图文]', UGT: '[卡片]', RTC: '[卡片]', S: '[系统消息]' }
/** The readable text of a message: its content for text, a placeholder otherwise. */
export function imText(message: ImMessage): string {
  const content = message.content ?? ''
  if (message.messageType === 'T') return content
  return PLACEHOLDER[message.messageType] ?? `[${message.messageType}]`
}
/** The message this one quotes, when 企信 returned it. */
export const imQuote = (message: ImMessage): z.infer<typeof ImQuoteSchema> | undefined =>
  message.replyMessageVo ?? message.replyMessage ?? message.quoteMessageVo ?? undefined
/**
 * True when the message was sent by the agent itself: the account's own id together with the AI marker the send path
 * appends. The account's own id alone means the person wrote it in their own client, which the agent does answer.
 */
export const imOwn = (message: ImMessage, self: ImSelf): boolean => message.senderId === self.id && !!message.tagFromLabel
/**
 * 企信 session kinds: `D` is a group, `S` a direct chat, `C` a parent of a cross-enterprise conversation, and `OSS1`,
 * `BOT`, `TODO`, `CRM`, `SS` are system channels. A direct chat carries no mention, so every message in it is addressed.
 */
export const DIRECT = 'S'
export const imDirect = (session: ImSession): boolean => session.sessionCategory === DIRECT
/**
 * Whether the message is addressed to the agent: a direct chat, a quote of the agent's own message, or a mention of its
 * name or identity. 企信 returns mentions as text in the content, and as an id list for some message types.
 */
export function imAddressed(message: ImMessage, session: ImSession, self: ImSelf): 'mention' | 'direct' | undefined {
  if (imDirect(session)) return 'direct'
  const quote = imQuote(message)
  // 企信 quotes carry the quoted sender's full id, which for a person is `E.fs.<senderId>`.
  if (quote && sameSender(quote.fullSenderId, self)) return 'direct'
  const ids = message.atFullUserIdList ?? []
  if (ids.some(id => id.includes(String(self.id)))) return 'mention'
  // A mention is text only: `@` followed by the display name. Rich-text and card messages keep their mention in the raw
  // content, so matching runs on that rather than on the placeholder the model sees.
  const text = message.content ?? ''
  if (self.names.some(name => name && text.includes(`@${name}`))) return 'mention'
  return undefined
}
/** Whether a full sender id names the agent: `E.fs.<id>` is the account's own id, and a bot may carry it too. */
export const sameSender = (fullId: string | null | undefined, self: ImSelf): boolean =>
  !!fullId && (fullId === self.fullId || fullId.endsWith(`.${self.id}`) || fullId.includes(`fs.${self.id}`))
/** Thread key of a message: its chat plus the message that anchors the topic (the quoted one, else itself). */
export const imThreadId = (session: ImSession, message: ImMessage): string =>
  `${session.sessionId}:${imQuote(message)?.messageId ?? message.messageId}`
/** Channel of a message: the chat it belongs to and the message a reply attaches to. */
export const imChannel = (session: ImSession, message: ImMessage) =>
  ({ source: SOURCE, thread: `${SOURCE}:${imThreadId(session, message)}`, address: { sessionId: session.sessionId, messageId: String(message.messageId) } })
/** One trigger id per message version, so an edited message is a new Trigger and a repolled one is not. */
export const imTriggerId = (message: ImMessage): string => key('im-message', String(message.messageId), String(message.messageVersion ?? 0))
/** Builds the Trigger for one message. */
export function imTrigger(session: ImSession, message: ImMessage, self: ImSelf): Trigger {
  const addressed = imAddressed(message, session, self)
  const quote = imQuote(message)
  return { id: imTriggerId(message), source: SOURCE, threads: [{ source: SOURCE, id: imThreadId(session, message) }],
    actor: { source: SOURCE, id: String(message.senderId), ...(message.senderName ? { name: message.senderName } : {}) },
    human: !/^BOT\./.test(message.fullSenderId ?? ''),
    at: new Date(message.messageTime).toISOString(), text: imText(message),
    ...(addressed ? { addressed } : {}), channel: imChannel(session, message),
    meta: { sessionId: session.sessionId, messageId: message.messageId, ...(session.sessionName ? { sessionName: session.sessionName } : {}),
      direct: imDirect(session), ...(quote ? { quoted: quote.messageId, quotedSender: quote.fullSenderId ?? null } : {}) } }
}
