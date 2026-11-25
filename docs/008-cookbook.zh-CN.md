# 008 Cookbook（实战手册）

[English](008-cookbook.md)

本实战手册说明如何扩展 dsh-superagent。文中使用了 [001 领域模型](001-domain.zh-CN.md) / [English](001-domain.md) 和 [002 授权](002-authorization.zh-CN.md) / [English](002-authorization.md) 中的术语，以及 [007 架构](007-architecture.zh-CN.md) / [English](007-architecture.md) 中的组件。

## 添加 Source

本节将实现一种名为 `webhook` 的 Source kind。它通过虚构的 CLI `hookq` 读取一个假想的消息队列，并将消息转换为 Trigger。其余接口均由 dsh-superagent 提供。

该实现有四项职责：转换事件、定义接收和授权规则、提供回复及上下文，以及维护轮询循环。以下编号步骤将按顺序构建这些部分。

示例假定 CLI 遵循以下约定：

- `hookq pull --after <n> --json` 按从旧到新的顺序输出位置 `n` 之后的消息：`{"me": "<the agent's id on the queue>", "items": […], "next": <position>}`。每个条目包含 `id`、`conversation`、`thread`（启动该 Thread 的消息 id；在启动消息自身上不存在）、带有 `id` 和 `bot` 的 `sender`、`mentions_me`、`text`、`at` 以及 `url`。
- `hookq reply --conversation <id> --to <message id> --key <key> --text <text>` 在一条消息下回复，并保证每个 key 只回复一次。若 conversation 已被删除，命令会失败并向标准错误输出 `{"error": {"code": 410, "message": "…"}}`。
- `hookq thread --conversation <id> --root <message id> --json`（后续页使用 `--after <cursor>`）按从旧到新的顺序输出 Thread 的一页：`{"items": […], "next": "<cursor>"}`；最后一页不包含 `next`。

参照 `src/sources/github.ts`，将该 kind 及其插件入口放在 `src/sources/webhook.ts` 中。如果 Source 规模增长，可像 Feishu Source 那样，将转换、Channel 和轮询代码拆到独立模块。

### 1. 将事件映射到领域模型

编写代码前先选择稳定的映射。Trigger id、Thread id 和 Channel address 会被持久化，因此之后改变它们可能会使已有记录失去关联。

| 概念 | 对于 webhook 队列 |
| --- | --- |
| Trigger | 一条消息 |
| Thread | 同一个 conversation 中的一条消息及其回复：`<conversation>:<id of the first message>` |
| Actor | 队列中的 sender id，与允许名单中使用的标识一致 |
| Channel address | conversation，以及回复所附着的消息 |
| 接收作用域 | 一个 conversation，在准入表中拥有自己的一行 |

### 2. 配置：schema、fields、facts 和 health

该模块需要导入下列步骤会用到的内容：

```ts
import type { Context } from '@deepseek-ai/cordis'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { key, threadKey, type OutboundMessage, type Trigger } from '../core/index.ts'
import { CliError } from '../infra/commands.ts'
import { KV } from '../kv.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import type { SourceKind } from './kind.ts'
```

```ts
const ConfigSchema = z.object({
  conversations: z.array(z.object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    listen: z.enum(['mentions', 'all']),
  }).strict()).default([]),
  pollSeconds: z.number().int().min(10).max(3600).default(30),
}).strict()
export type WebhookConfig = z.infer<typeof ConfigSchema>

export const webhookKind: SourceKind<WebhookConfig> = {
  kind: 'webhook',
  title: { zh: 'Webhook 队列', en: 'Webhook queue' },
  description: { zh: '接收 webhook 队列里下列对话的消息。', en: 'Receives the messages of these conversations from the webhook queue.' },
  schema: ConfigSchema,
  fields: [
    { key: 'conversations', type: 'rows', label: { zh: '接收的对话', en: 'Conversations' }, columns: [
      { key: 'id', type: 'text', label: { zh: '对话', en: 'Conversation' }, pattern: '[a-z0-9-]+' },
      { key: 'listen', type: 'select', label: { zh: '接收', en: 'Receive' }, options: [
        { value: 'mentions', label: { zh: '仅 @', en: '@ only' } }, { value: 'all', label: { zh: '全部消息', en: 'All' } }] },
    ] },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 10, max: 3600,
      label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' } },
  ],
  health: ['webhook'],
  // find, scope, channel, threadContext, policy and environment follow in the next steps.
}
```

- `kind` 是稳定的 Source id。它会出现在 Trigger 的 `source`、Thread key 前缀、`source:webhook` 设置块以及 Source Policy 中。
- `schema` 校验持久化配置并提供默认值。在操作员保存实例之前，注册表会使用这些默认值创建一个已启用实例。默认值应当不接收任何内容；本示例默认不配置 conversation。
- `fields` 无需编写自定义面板代码即可生成 Source 设置表单。`rows` 字段编辑以第一列为 key 的条目；`advanced` 会隐藏较少使用的设置。如果 Source 可以把 id 解析成显示名称，请实现 `refreshLabels`，并将这些名称保存在 `KV.sources.labels(kind)` 下。带有 `choose` 和 `refresh` 的列随后便可以提供这些名称。
- 可选的 `facts(deployment)` 显示由 setup 推导出的值，例如某个 CLI 背后的账户。setup 当前只检查 `SETUP_FIELDS` 中列出的 GitHub 和 Feishu 字段，因此本示例不提供 facts。
- `health` 声明该 Source 的健康项，其初始状态为 `starting`。注册时会认领每个名称，并拒绝与 `runtime`、`reply`、`worker` 或 effect kind 等条目发生冲突。应使用 kind 自身的名称，并为 Policy 同步保留 `sync:<id>`。`error` 会使状态脚本以状态码 2 退出，并使每小时检查通知操作员，因此只有在可能需要人工处理时才报告该状态。

### 3. 将消息转换为 Trigger

转换 CLI 响应前，先对其进行校验：

```ts
/** One message as `hookq pull` and `hookq thread` print it. */
const MessageSchema = z.looseObject({
  id: z.string().min(1), conversation: z.string().min(1), thread: z.string().optional(),
  sender: z.looseObject({ id: z.string(), bot: z.boolean().default(false) }), mentions_me: z.boolean().default(false),
  text: z.string(), at: z.string(), url: z.string().optional(),
})
type QueueMessage = z.infer<typeof MessageSchema>
/** The answer of `hookq pull`, whose items are read one by one, and of `hookq thread`. */
const PageSchema = z.looseObject({ me: z.string(), items: z.array(z.unknown()), next: z.number().int() })
const ThreadPageSchema = z.looseObject({ items: z.array(MessageSchema), next: z.string().optional() })
```

```ts
/** The Trigger of one queue message; the agent's own messages produce none. */
export function webhookTrigger(message: QueueMessage, me: string): Trigger | undefined {
  if (message.sender.id === me) return undefined
  const thread = `${message.conversation}:${message.thread ?? message.id}`
  return {
    id: key('webhook', message.id),
    source: 'webhook',
    threads: [{ source: 'webhook', id: thread }],
    actor: { source: 'webhook', id: message.sender.id },
    human: !message.sender.bot,
    ...(message.mentions_me ? { addressed: 'mention' as const } : {}),
    at: message.at,
    text: message.text,
    channel: { source: 'webhook', thread: `webhook:${thread}`,
      address: { conversation: message.conversation, message: message.id, ...(message.url ? { url: message.url } : {}) } },
    ...(message.url ? { url: message.url } : {}),
    meta: { conversation: message.conversation, messageId: message.id, root: message.thread ?? message.id },
  }
}
```

- **稳定 id。** 通过 `key` 从队列 id 派生 Trigger id。对于已持久化的 id，`Engine.receive` 返回 `duplicate`，而重复接收同一事件只会创建一个 Ticket。因此重复读取消息是安全的。若要把编辑视为新事件，请像 GitHub 对 comment 的 `updated_at` 所做的那样，将编辑版本包含在 id 中。
- **Thread。** 第一个 Thread 是 primary，并拥有 Eval。额外的 Thread 会增加 Correlation 上下文。Source 选择 id；其完整 key 为 `webhook:<id>`。
- **发送者。** 在 `actor` 中使用 Source 原生 id。对于 bot 和 CI，将 `human` 设为 `false`。在名单中的 bot 只能成为 inferred candidate。空 actor id（例如 CI）会使用未列入名单且未被直接寻址的发送者所对应的准入单元格。只有当消息确实在寻址智能体时，才将 `addressed` 设为 `mention` 或 `direct`；这会为允许人员的消息赋予 explicit strength。绝不要为智能体自己的消息生成 Trigger。
- **回复目的地和元数据。** `channel` 标识回复发往何处；`url` 链接到源消息。`channel.thread` 将消息分组以便有序投递：同一个 Ticket 的后续消息会等待其较早消息完成，直到较早消息已经失败三次。其他 Ticket 不会等待。将 Source 特有字段保存在 `meta` 中，例如接收消息的 conversation 和 Thread root。`meta` 和 `text` 都是不可信数据，不能作为授权依据。

Agent 可以通过 `orchestrator_read trigger/<id>` 和 `thread/<key>` 读取新 kind。它们会暴露消息文本、disposition 和相邻 Trigger。新 kind 不会自动获得内置 skill、原始服务记录对应的 resource 或 pull-request binding。

文本搜索无需额外代码即可工作。当用户会使用消息 id、URL 或 `#12` 等 Source 特有引用时，实现 `find(query)`。返回这些引用所标识的 Thread key 和搜索词：

```ts
  find: query => ({ threads: [], terms: [...new Set(query.match(/\bm[0-9]+\b/g) ?? [])] }),
```

此处，查询中的队列消息 id（例如 `m42`）会用于搜索 Trigger。

### 4. Source 接收什么：scope

```ts
  scope({ meta }, config) {
    const conversation = config.conversations.find(item => item.id === meta.conversation)
    if (!conversation) return { listened: false, reason: 'conversation_not_listed' }
    return { listened: true, observed: conversation.listen === 'all', row: conversation.id }
  },
```

Engine 会通过 `SourceRegistry` 对每个传入 Trigger 调用 `scope`。作用域外的消息会以 filtered 状态持久化并附带原因，且不会创建 Thread。应将消息传给 `receive`，而不是在轮询循环中悄悄丢弃，这样面板才能解释过滤原因。

`observed: true` 表示 Source 会接收该作用域内未寻址的消息，从而允许准入表对它们作出决定。`row` 标识对应的准入行。

重新校验会使用 Mandate 中保存的元数据调用 `scope`。应让它只依赖于 `meta` 和配置。恢复执行只要求 `listened`，不要求 `observed`。如果没有 `scope`，一个 kind 会接收自己生成的每个 Trigger，但不会观察任何 Trigger。

### 5. 回复：Channel

```ts
  channel: {
    allowed: (address, config) => config.conversations.some(item => item.id === address.conversation),
    send: sendWebhook,
    link: address => ({ url: address.url ?? '',
      label: { zh: `Webhook 对话 ${address.conversation}`, en: `Webhook conversation ${address.conversation}` } }),
  },
```

```ts
export async function sendWebhook(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const { conversation, message: to } = message.channel.address
  if (!conversation || !to) throw new Error('Missing webhook reply target')
  try {
    await host.commands.run('hookq', ['reply', '--conversation', conversation, '--to', to, '--key', message.id,
      '--text', message.text])
    return 'sent'
  } catch (error) {
    if (error instanceof CliError && error.code === 410) return 'gone'
    throw error
  }
}
```

- **幂等发送。** Outbox 调用 `SourceRegistry.send`，后者会调用 `channel.send`。Source 插件未加载时，消息会等待。一次发送可能在远端服务已经收到消息后才失败，因此重试不能产生重复消息。使用 `message.id` 作为幂等 key：`hookq` 支持 `--key`；GitHub 保存隐藏的 comment marker；Feishu 接受 idempotency key。
- **永久失败与可重试失败。** 成功时返回 `sent`；只有在投递永久不可能完成时（例如示例中的 410）才返回 `gone`。gone 消息会以 dropped 状态保留且永不再次入队；它会出现在 `GET sources` 和 Source 页面中。其他失败应抛出异常，使 Outbox 在 5 秒后重试，并将间隔加倍，最大为 300 秒。`CliError.code` 是 CLI 输出所报告的 code。
- **允许的目的地。** `allowed(address, config)` 只检查已保存的 address 和当前配置。应把所有必需事实放进 address；例如，Feishu 会记录 chat 是否为 direct。不再监听的目的地会被丢弃，而禁用 Source 则会让消息继续等待。如果没有 `allowed`，Source 启用期间会允许所有 address。
- **链接。** `link(address, links)` 返回面板通过 `SourceRegistry.link` 显示的 URL 和 label。

### 6. 供 assessment 使用的 Thread 上下文

```ts
  threadContext: {
    messageId: trigger => String(trigger.meta.messageId ?? ''),
    // A queue thread is flat: its root, and the message a reply answers, are on its first page, as on GitHub.
    read: async (commands, trigger, _part, cursor) => {
      const page = ThreadPageSchema.parse(JSON.parse(await commands.run('hookq', ['thread', '--conversation',
        String(trigger.meta.conversation), '--root', String(trigger.meta.root), '--json', ...(cursor ? ['--after', cursor] : [])])))
      const messages = page.items.map(item => ({ id: item.id, from: item.sender.id, at: item.at, text: item.text,
        ...(item.sender.bot ? { bot: true as const } : {}), ...(item.url ? { url: item.url } : {}) }))
      return { messages, ...(page.next ? { next: page.next } : {}), body: { messages } }
    },
  },
```

主动 assessment 需要 Trigger 周围的 conversation。`orchestrator_eval` 读取初始窗口；`orchestrator_eval_read` 扩展分页，或读取 root、parent message。实现可选的 `threadContext` 接口来提供这些读取能力：

- `read(commands, trigger, part, cursor, config)` 返回 `ContextPart`。其中的 `messages` 使用 `ContextMessage`：`{id, from, at, text}`，并按需附加 `bot`、`deleted`、`reply_to`、`url`、`path` 和 `line` 字段。最后一页省略 `next`。`body` 是展示给进行 assessment 的 Session 的内容，此处与 messages 相同。可选的 `status` 可以描述 Feishu 的 `chat_neighbours` 等特殊结果。`part` 的值为 `thread`、`root` 或 `parent`。
- `messageId(trigger)` 在这些消息中找出 Trigger 自身的消息。
- `images(text)` 和 `image(…)` 用于消息携带图片的 kind，例如 Feishu；本示例未实现它们。

没有 `threadContext` 的 kind 无法为 assessment 提供 Thread 上下文；Trigger 自身的文本仍然可读。

如果消息会回复较早的消息，请添加 `repliesTo(trigger)`。它返回对应的 Trigger id，使后续通知和 worker Input 能够在已持久化时显示被回复的消息。例如，如果 `hookq` 提供 `reply_to`，且转换过程将其保存为 `meta.replyTo`：

```ts
  repliesTo: trigger => typeof trigger.meta.replyTo === 'string' ? key('webhook', trigger.meta.replyTo) : undefined,
```

### 7. 谁可以提出请求：Source 所负责的 Policy 部分

```ts
  policy: {
    schema: z.object({ allowed: z.array(z.object({ id: z.string().min(1), name: z.string().trim().max(100).optional() }).strict())
      .default([]) }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的发送者', en: 'Senders who may originate work' }, columns: [
      { key: 'id', type: 'text', label: { zh: '发送者', en: 'Sender' } },
      { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] }],
    explicit: { zh: '名单里的人在消息里 @ 智能体。', en: 'Someone on the list mentions the agent in a message.' },
    rows: stored => ConfigSchema.parse(stored).conversations.map(conversation => {
      const all = conversation.listen === 'all'
      return { id: conversation.id, label: conversation.id, note: all ? { zh: '全部消息', en: 'All' } : { zh: '仅 @', en: '@ only' },
        cells: { listedUnaddressed: all, unlistedAddressed: true, unlistedUnaddressed: all } }
    }),
  },
```

- `schema` 校验 Source Policy，包括 `allowed` sender id。id 比较不区分大小写。准入表单独校验，并在各 kind 之间共享。这个 Policy 部分保存在 `policy.sources.webhook`，并参与生成 Policy version。
- `fields` 在 **Eval → On each Source** 下生成表单，表单以 `allowed` 开始。`explicit` 解释如何寻址智能体。可选的 `unnamed: {person, bot}` 为 Feishu 的 `ou_…` 等不透明 id 提供显示 label；本示例省略了该字段，因为队列 id 本身就是可读名称。
- `rows(config)` 列出准入作用域及其可用单元格。每个 row id 都必须与 `scope` 返回的 `row` 匹配。仅在 Source 会观察未寻址消息的地方，未寻址消息对应的单元格才可用。没有 `rows` 的 kind 使用默认单元格。
- 可选的 `bots` 使用与 `allowed` 相同的条目形状，列出具备 inferred candidacy 资格的 bot。没有该字段时，不会准入任何 bot。
- 可选的 `sync: {label, ready(part), run(host, part, signal)}` 会在启动时以及点击 **Sync now** 时刷新成员关系。Feishu 使用 chat membership。失败会显示在 `sync:<id>` 下，并在一分钟后重试，此后将间隔加倍，最大为一小时，直到成功为止。

### 8. Executor 使用的变量

```ts
  environment: {
    variables: [{ key: 'DSH_SUPERAGENT_WEBHOOK_CONVERSATION', description: {
      zh: '接下工单的 webhook 对话；工单不是从这个来源来的时为空',
      en: 'The webhook conversation that started the ticket; empty when the ticket did not start on this Source' } }],
    values: ({ trigger }) => ({
      DSH_SUPERAGENT_WEBHOOK_CONVERSATION: trigger?.source === 'webhook' ? String(trigger.meta.conversation ?? '') : '' }),
  },
```

即使 Source 已禁用，执行设置仍会在 prepare command 旁显示已声明的 `variables`。Source 启用时，`values` 会根据 deployment、配置和发起 Ticket 的 Trigger 提供 Ticket 特有的值。

prepare command 读取环境变量；worker 则在自身指令中读取这些变量的值。使用 `DSH_SUPERAGENT_<KIND>_…` 前缀；对于来自其他 Source 的 Ticket 返回空值；绝不要包含凭证。

### 9. 插件入口及其循环

```ts
export const name = 'dsh-superagent-webhook'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(webhookKind), 'webhook: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, webhookKind)
    const controller = new AbortController()
    // DSH ends its process on an unhandled rejection, so a failure that escapes the loop becomes the Source's health.
    const running = watch(source, controller.signal)
      .catch((error: unknown) => { source.report('webhook', { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}
```

插件注入 `orchestrator`。第一个 effect 注册该 kind，并在释放时将其注销。第二个 effect 使用 `SourceContext` 运行轮询循环。释放过程会中止循环并等待它结束；应用停止或重启时也是如此。

```ts
async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  // Setup restarts dsh-superagent once it resolves the accounts; until then the Source reads nothing.
  if (!ctx.configured()) { ctx.report('webhook', health('paused', 'setupPending')); return }
  let failures = 0
  while (!signal.aborted) {
    const config = ctx.config<WebhookConfig>('webhook')
    if (!config) ctx.report('webhook', health('paused', 'sourceOff'))
    else {
      const at = new Date().toISOString()
      try {
        const { read, unreadable } = await pollQueue(ctx, signal)
        failures = 0
        ctx.report('webhook', { state: 'ready', detail: `${read} messages, ${unreadable} unreadable`, at })
      } catch (error) {
        failures += 1
        // One network failure is retried on the next round; three in a row need a person.
        if (!signal.aborted && failures >= 3) {
          ctx.report('webhook', health('error', 'pollFailures', { count: String(failures), error: String(error) }))
        }
      }
    }
    await delay((config?.pollSeconds ?? 30) * 1000, undefined, { signal }).catch(() => {})
  }
}

/** Read the queue after the cursor, take in each message, then move the cursor past them. */
export async function pollQueue(ctx: SourceContext, signal: AbortSignal): Promise<{ read: number; unreadable: number }> {
  const after = ctx.state.get(KV.webhook.cursor) ?? 0
  const output = await ctx.commands.withSignal(signal).run('hookq', ['pull', '--after', String(after), '--json'])
  const page = PageSchema.parse(JSON.parse(output))
  let unreadable = 0
  for (const item of page.items) {
    if (signal.aborted) throw new Error('The webhook Source stopped during the read')
    const message = MessageSchema.safeParse(item)
    if (!message.success) { unreadable++; continue }
    const trigger = webhookTrigger(message.data, page.me)
    if (!trigger) continue
    await ctx.receive(trigger)
    const conversation = { label: { zh: '对话', en: 'Conversation' }, value: message.data.conversation }
    for (const ref of trigger.threads) ctx.threads.describe(threadKey(ref), { facts: { conversation } })
  }
  ctx.state.set(KV.webhook.cursor, page.next)
  return { read: page.items.length, unreadable }
}
```

- **Setup 与开关。** 等待 `ctx.ready`；当 `ctx.configured()` 为 false 时，不读取任何内容。每一轮都读取 `ctx.config(kind)`：Source 关闭时其值为 undefined。
- **Cursor。** 使用 `KV`（`src/kv.ts`）中的类型化条目，将读取位置保存在 `ctx.state`，例如 `webhook: {cursor: record<number>('webhook-cursor')}`。`tests/store.spec.ts` 要求 key 字面量只能出现在该注册表中。外部 package 可以通过导出的 `record` 和 `family` 定义 key。设置为 `undefined` 会删除记录；`ctx.atomic` 将多次写入组织到一个事务中。

  只有在覆盖的每个 Trigger 都已持久化后，才能推进 cursor。被中断的一轮会保持 cursor 不变；稳定 id 使重放安全。对于 timestamp cursor，`src/sources/poll.ts` 中的 `cursorAt(started)` 会减去五秒，以容纳较晚到达的远端写入。
- **Thread 元数据。** 收到 Trigger 后，调用 `ctx.threads.describe(key, {label, url, facts})` 来填充其显示信息。`ctx.threads.patch(key, meta)` 会委托给 `threads.patchMeta`，设置 Source 所拥有的 key；当值为 `undefined` 时则删除该 key。两者都会忽略不存在的 Thread，包括 filtered Trigger 的 Thread。
- **逐条错误。** 统计格式错误的条目并继续处理，而不是让整个批次失败。`src/infra/commands.ts` 中的 `validItems(item, list, tally)` 支持这种模式。对于独立轮询的 Thread，使用 `src/sources/poll.ts` 中的 `pollThreads`；它会把每次失败记录为 `pollError`。它的 `polled` 谓词会保留实时订阅，以及从最后一个 Trigger 与 Ticket 结束时间两者中较晚者起算的两周窗口。
- **Health。** 只通过 `ctx.report` 写入已声明的条目。`health(state, code, values)` 提供 `setupPending`、`sourceOff` 和 `pollFailures` 等固定消息。连续失败达到一定次数后才报告 `error`。
- **Abort。** 将 signal 传给 `ctx.commands.withSignal(signal)` 和 `delay`，并在条目之间检查它，以便停止或重启能立即结束循环。

本示例不发送由 Source 发起的通知。需要此功能的 Source 可以调用 `ctx.notify`；Outbox 会像投递其他回复一样投递这些通知。

本示例也不会把 Thread 与 Ticket 完成绑定。只有当 Source 的 Thread 生命周期决定工作是否完成时，才使用 `ctx.tickets.bindThread` 和 `threadClosed`，GitHub pull request 就属于这种情况。Ticket 何时结束仍由 Engine 决定。

### 10. 注册插件

在 `tsdown.config.ts` 中将该模块构建为独立入口：

```ts
entry: { index: 'src/index.ts', 'github-watch': 'src/sources/github.ts', 'feishu-watch': 'src/sources/feishu.ts',
  'webhook-watch': 'src/sources/webhook.ts' },
```

然后在 `package.json` 中导出构建产物：向 `exports` 添加 `"./webhook-watch": "./lib/webhook-watch.js"`；再像 Feishu 那样，把插件加入 bundle 的 `cordis.patch.yml` 的 `insert` 列表，并将其禁用：

```yaml
    - id: dsh-superagent-webhook
      name: dsh-superagent/webhook-watch
      disabled: true
```

在 profile 的 `cordis.patch.yml` 中使用 `id: dsh-superagent-webhook` 和 `disabled: false` 启用该插件。完成构建并重启。新的 Source 会出现在 Sources 设置以及 **Eval → On each Source** 下。

将其模块和 spec 加入 [007 架构](007-architecture.zh-CN.md) / [English](007-architecture.md) 的模块表和测试表。`tests/docs.spec.ts` 会检查两个索引是否完整。

### 11. 测试

按照 `tests/sources.spec.ts` 中的模式创建 `tests/webhook.spec.ts`：使用临时目录中的真实 Store、带 `HealthBoard` 的 `SourceRegistry`、使用替身 port 的 Engine，以及通过 `sourceContextOf` 创建的 `SourceContext`。

通过监视 `Commands.run` 来模拟 CLI 调用。还要监视 `withSignal`，因为它通常会返回一个新的 `Commands` 实例。

```ts
function host(overrides: Partial<SourceContextDeps> = {}) {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'webhook-')), 'db.sqlite'))
  store.saveSettings(SettingsSchema.parse({
    sources: { webhook: { enabled: true, config: { conversations: [{ id: 'ops', listen: 'mentions' }] } } },
    policy: { sources: { webhook: { allowed: [{ id: 'alice' }] } } },
  }))
  // The registry claims the kind's health entries on the board, where the test reads them.
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board)
  sources.register(webhookKind)
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources),
    assessor: { request: vi.fn() }, executor: { start: vi.fn(), deliver: vi.fn(), stop: vi.fn() },
    outbox: { send: vi.fn(), status: () => undefined, withdraw: vi.fn() } })
  const commands = new Commands(() => testDeployment(), {}, new AbortController().signal)
  const receive = vi.fn((trigger: Trigger) => { const result = engine.receive(trigger); engine.evaluateDue(); return result })
  // The Source's own notices go to the outbox, which keeps their receipts and sends nothing here.
  const deps: SourceContextDeps = { store, engine, outbox: { send: message => { store.receipts.add(message) } }, commands, sources,
    deployment: testDeployment(), ready: Promise.resolve(), configured: () => true, receive, ...overrides }
  return { ...deps, store, engine, commands, receive, health: board.all, ctx: sourceContextOf(deps, webhookKind) }
}
/** The queue as `hookq` answers it. */
function queue(h: ReturnType<typeof host>, answer: () => unknown) {
  vi.spyOn(h.commands, 'withSignal').mockReturnValue(h.commands)
  return vi.spyOn(h.commands, 'run').mockImplementation(async () => JSON.stringify(answer()))
}

it('takes in what the queue holds after the cursor, once, and moves the cursor after it', async () => {
  const h = host()
  queue(h, () => ({ me: 'agent', items: [message('m1'), { id: 'broken' }, message('m2', { conversation: 'elsewhere' })], next: 3 }))
  expect(await pollQueue(h.ctx, new AbortController().signal)).toEqual({ read: 3, unreadable: 1 })
  expect(await h.receive.mock.results[0]!.value).toBe('stored')
  expect(await h.receive.mock.results[1]!.value).toBe('filtered')
  expect(h.store.get(KV.webhook.cursor)).toBe(3)
  // An allowed sender who mentions the agent makes an explicit request.
  expect(h.engine.candidate(key('webhook', 'm1'))?.strength).toBe('explicit')
  await pollQueue(h.ctx, new AbortController().signal)
  expect(await h.receive.mock.results[2]!.value).toBe('duplicate')
  h.store.close()
})
```

`message(id, fields)` 构造一个队列条目。至少覆盖以下内容：

- 转换：稳定 id、Thread、actor、`human` 和 `addressed`，以及不为智能体自身的消息生成 Trigger；
- 一轮轮询：Trigger 只持久化一次，作用域外的一条消息处于 `filtered` 状态，cursor 在这些消息处理后推进，允许发送者的 mention 被评估为 `explicit`；
- 一轮中途被中断，cursor 保持不变；
- `send`：成功时为 `sent`，仅针对 410 返回 `gone`，其他失败均抛出异常，其中 CLI error 通过 `commandError` 构造；
- Thread 上下文：一页中的消息和下一页 cursor，方式与 `tests/registry.spec.ts` 通过 `SourceRegistry.threadContext` 读取 kind 的 Thread 相同；
- 插件：`apply` 注册 kind；setup 等待期间报告 `setupPending`；其 disposer 注销 kind；从循环逸出的失败会成为 Source 的 health，而不会成为未处理的 rejection；
- Source 所负责的 Policy 部分及其准入行，与 `tests/registry.spec.ts` 和 `tests/policy.spec.ts` 检查 Feishu Source 的方式相同。

### 检查清单

1. 映射 Trigger、Thread、actor、Channel address 和接收作用域。
2. 编写 kind：`schema`、`fields`、`health`，以及 setup 会推导信息时所需的 `facts`。
3. 使用稳定 id 将事件转换为 Trigger，并丢弃智能体自己的事件。
4. 仅根据 `meta` 决定 Source 在 `scope` 中接收什么。
5. 为其提供 Channel：`send` 对每条消息只发送一次，并且仅当 conversation 永远无法接收消息时才返回 `gone`。
6. 如果它能够读取 Thread，则为 assessment 提供 Thread 上下文。
7. 为其提供包含 `allowed` 和准入行的 Policy 部分。
8. 注册它的执行环境变量。
9. 编写插件入口和循环：等待 setup、遵循开关、在 `receive` 后推进 cursor、逐条处理错误、报告 health 并在 abort 时停止；在 `KV` 中命名 cursor。
10. 添加构建入口、export 和 `cordis.patch.yml` insert，并在 007 的表格中列出该模块及其 spec。
11. 像 `tests/sources.spec.ts` 测试其他 Source 那样测试它。
