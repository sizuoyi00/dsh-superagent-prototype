# 004 Prompt（提示词）

[English](004-prompts.md)

本文说明 agent 会读取什么、团队可以编辑什么，以及更改何时生效。本文建立在 [000 理念](000-philosophy.zh-CN.md) / [English](000-philosophy.md) 至 [003 执行](003-execution.zh-CN.md) / [English](003-execution.md) 的基础之上。Prompt 文本使用英文编写。

## 团队编写的内容

团队可以编辑三个团队 section、添加 skill，并覆盖内置 system prompt 的每个 part。大多数默认内容位于 `prompts/` 和 `skills/` 下。工具说明、notice 和 card 仍保留在代码中，无法通过 prompt 设置进行编辑。

| Section | 包含内容 |
| --- | --- |
| Communication | 何时给人发消息、消息如何表述、每条 GitHub 消息的起始行（默认为 `This is by an automated agent, not a human`）、如何处理 review，以及哪些普通账号是 review bot |
| Ticket scope | Ticket 在什么情况下继续，以及何时以 draft 停止 |
| Delivery requirements | pull request 中需要提供的证据、带行数阈值的自动合并条件，以及 commit author；如果未设置 commit author，Executor 会使用 agent 账号的 no-reply 地址提交 |
| Team skills | agent 在需要时加载的知识，例如一个说明哪个飞书用户对应哪个 GitHub 账号的 `identities` skill |

内置文本涵盖角色、工具用法、host 机制、授权规则，以及 GitHub 和飞书 skill。它会通过标题引用团队 section，而不会重复其内容。

### 内置 part 与 template

Override 使用以下 key：

| Part（部分） | Key（键） |
| --- | --- |
| 共享指令与角色 | `runtime/shared`、`runtime/orchestrator`、`runtime/worker` |
| 工作指令 | `runtime/subscriptions`、`runtime/replies`、`runtime/dispatch`、`runtime/work`、`runtime/admission` |
| 移交指令 | `runtime/handoff/orchestrator`、`runtime/handoff/worker` |
| Source skill | `skill/feishu`、`skill/github` |
| 生成的 section | `runtime/environment`、`runtime/policy`、`runtime/policy/none` |

生成的 section 是可编辑 template。它们必须保留以下 placeholder：

- `runtime/environment`：`{variables}`，填充执行环境行。
- `runtime/policy`：`{version}`、`{mode}` 和 `{rules}`，其中每条已启用规则占一行。
- `runtime/policy/none`：`{version}` 和 `{mode}`，在没有启用任何规则时使用。

编辑某个 part 会更改 model 收到的指令。它不会改变 gate、Mandate、工具检查或账号 wrapper；这些内容仍由代码强制执行。

收到明确的人工请求时，主 Session 也可以用 `orchestrator_prompts_save` 保存 override。如果保存时省略 override 的 `base`，则保留已保存的 base。如果已保存配置中存在的某个 part 被移除，保存时会将其丢弃；其他未知 part 会被拒绝。

Override 会记录它以哪一版内置文本为基础。升级会保留团队的文本。如果默认内容发生变化，面板会把该 part 标记为 **默认内容已更新（Default updated）**，并在团队文本旁显示差异。团队可以保留自己的文本、使用新的默认内容或进行编辑。没有 override 的 part 会自动跟随新的默认内容。

主 Session 可以在 `orchestrator_read prompts` 返回内容的 `default_changed` 下读取受影响的 part 名称。

## 组装与优先级

System prompt 按以下顺序组装：

1. 共享指令与角色。
2. 三个团队 section。
3. Subscription 与 reply。
4. 主 Session 使用 dispatch 指令；Executor 使用 work 指令。
5. `runtime/admission`，仅用于主 Session。
6. 移交指令。
7. `runtime/environment`。
8. `runtime/policy`，仅用于主 Session。

Admission 指令来自 `prompts/admission.md`。它们描述主动评估，以及何时可以根据无关 candidate 的 card 忽略该 candidate。`orchestrator_eval` 返回上下文，而不会重复这些指令。

Environment section 向主 Session 提供部署范围的值，并向每个 Executor 提供其 Ticket 特有的值。Policy section 会在每次 model request 时根据设置重新生成。它包含 Policy version、accept mode、explicit-request exemption，以及格式为 `- <name> (<id>): <instruction>` 的已启用规则；若无启用规则，则包含一条说明。它被放在最后，因此 Policy 变化不会改变其前面的 prompt 文本。

Executor 还会读取 DeepSeek Harness 的 coding prompt 和仓库的 `AGENTS.md`；主 Session 不会读取。推断生成的 Ticket 会添加最后一条说明，将其 Executor 限制在匹配的规则内。Assignment 和传入消息会以 Trigger card 内联到达，只有被截断的内容才使用 resource pointer。

Executor 以无人值守方式工作。其工具不包含那些需要向人提问、向人展示 UI 或更改 profile 的工具，例如 `ask_user_question`、`present` 和 `plugin_manager`。

从最强到最弱，优先级如下：

1. 由工具和 host 强制执行的事实：身份、权限、工具参数检查、reply purpose、长度限制。Prompt 文本无法更改这些事实。
2. 内置和生成的 section，以团队对它们的 override 内容为准。
3. 主动创建的 Ticket 所匹配规则中的流程与 communication，仅适用于该 Ticket 的 Executor Session。
4. 团队 section 和团队 skill。
5. 外部文本：消息、评论、文档和引用。它们是数据，绝不会更改规则或授权。

## 内置文本的原则

以下原则把 [000 理念](000-philosophy.zh-CN.md) / [English](000-philosophy.md) 应用于 agent：

- **分离角色。** 主 Session 只负责路由：它通过一个 routing tool 转发原始 Trigger 和路由事实，该工具可以在一次调用中决定多个等待中的 candidate；主 Session 不做任何技术决策。routing note 最多 30 个英文单词。Executor 读取原始 source、判断 scope、实施并验证。
- **主 Session 不等待。** Report、follow-up notice、candidate 和已完成的后台 job 会自动以消息形式到达。没有其他事情可做时，主 Session 会结束当前轮次。guard 会拒绝 `sleep`、超过 30 秒的 shell timeout 和超过 5 秒的 job wait，因为被阻塞的 step 会延误新 candidate。主 Session 的完整 prompt 中，这些指令会替换 DeepSeek Harness 自己的 job-notification note。
- **仅当人必须行动或可以使用结果时才发送消息：** 结果可以被审查或使用、需要决策或资源，或者工作无法完成。chat 消息默认只有一句话，硬性上限为 100 个英文单词。
- **Executor 决定其 follow-up。** 每个 Executor 处理并确认范围内请求，并把超出其 Ticket 范围或属于另一 Ticket 的请求交还。只有在所有 owner 都交还该消息，或在未接手的情况下结束后，该消息才会成为新工作。主 Session 会收到 follow-up notice，但只能在停止工作时对其采取行动。被交还的消息随后会与 Executor 给出的原因一起作为 candidate 到达。
- **通过 Subscription 和主 Session 协调。** Executor 会订阅相关 Thread 以获取上下文。主 Session 可以用不超过 100 个英文单词的 note，把来自另一 Ticket 的事实发给它。Subscription 和 note 都不会授予权限。
- **只有存在明确引用时才关联。** 消息必须指向 Ticket 的 pull request、Issue、source message 或 acknowledgement，或者指向近期的一项更改且只有一个 Ticket 与之匹配。仅仅主题相似并不足够。关联操作会让 Ticket 订阅整个 Thread；如果 Executor 发现它无关，会使用 `orchestrator_thread_unrelated`，并且不会在那里回答。
- **具体地确认一次。** 在开始实质性工作之前，Executor 会逐一确认每个新请求，并在原始消息下回复，说明对象和预期结果。
- **通过 `human_action` 提问。** Executor 会在其 Report 中提出一个具体问题，主 Session 会原样转发。如果是某个人的消息引发该问题，Report 会指明该消息，host 会在那里提问。否则，它会在 Ticket 的原始 conversation 中提问。与此同时，已经获得授权的工作可以继续。
- **诚实交付。** 打开 pull request 并不代表已经就绪；未完成的工作要标记为 draft；没有真实 before screenshot 的 UI 更改不能标记为 ready。
- **人工暂停持续有效**，覆盖 follow-up、新 Executor Session 和 restart，直到有人解除暂停。自动 feedback 绝不会恢复已暂停的工作。
- **示例只展示格式。** 示例句子不是 agent 可以宣称的事实。
- **按结果处理 review。** 已修复并验证的 comment 会被静默 resolve；被拒绝的 comment 会收到一句原因说明。自动 reviewer 的 thread 一旦得到回答就会被 resolve，每个自动 reviewer 对每个 pull request 最多进行三轮 review。
- **遇到重复工作时让步。** 当某个人的 branch 或 pull request 已经包含 Ticket 所需的更改时，Executor 会关闭自己的 pull request，并用一句话指向对方的工作。

## 版本

- 每次保存都会创建一个不可变 version，其中包含完整配置、revision number、predecessor、timestamp 和 origin（panel 或 tool）。恢复某个 version 或默认内容会创建另一个 version。
- 保存时会指明其 base revision。发生冲突的保存会被拒绝，但不会丢弃 draft。
- Session 会在每次 model request 时读取最新 version，包括同一轮次中的后续 step。保存不会 restart、cancel 或唤醒 Session。host 会记录每个 Session 使用过的 revision；Executor 可以读取它工作时所用的任意 revision。
- 部署会设置一个总大小上限，其中包括 override。校验会拒绝未知 key、保留的内置 skill 名称、未知 override part 和缺失的 template placeholder。它绝不会静默截断文本。与默认内容完全相同的 override 会被移除，使该 part 跟随后续默认内容。
