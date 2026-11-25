# 002 授权

[English](002-authorization.md)

Authorization（授权）决定谁可以启动工作，以及该工作可以包含哪些内容。本文档建立在 [001 领域模型](001-domain.zh-CN.md) / [English](001-domain.md) 之上。

宿主程序负责强制执行允许名单、规则和 Mandate（授权）。消息、评论和被引用的文档都是决策的输入；它们无法改变这些权限。

## Trigger 的两条路径

### Eval：决定是否启动工作

Source（来源）会记录一条消息是否指向智能体：提及机器人或智能体账户时记为 `mention`，直接消息则记为 `direct`。gate（准入）检查发送者以及该 Source 的 Policy（策略）：

- 允许名单中的人指向智能体时，构成明确请求。
- 某个人在已有 Ticket（工单）的 Thread（线程）上继续跟进时，遵循下述规则。
- 其他人的消息依据其接收范围对应的准入表处理。
- Source 机器人名单中的机器人可以产生推断候选项，但绝不能产生明确请求。其他机器人不予准入。

### Subscription：继续已有工作

已订阅 Thread 上的每条消息都会作为上下文到达订阅该 Thread 的 Ticket，包括来自机器人和 CI 的消息。这种投递绕过 gate，且不授予任何新权限。每个 Ticket 仍受其 Mandate 限制。

某个人在 Ticket 自有 Thread 上发送的消息，由该 Ticket 的 Executor（执行器）决定如何处理。Main Session（主 Session）把消息附加到某个 Ticket 时也是如此。消息由 Executor 拥有期间，不进入 Eval（评估），也不产生 Decision（决定）。每个 Executor 要么在其 Ticket 的 scope（范围）内处理请求，要么把请求交还，以便路由到其他地方。

只要 Ticket 仍处于活动状态，所有权就会持续存在，即使某个人移除了它的 Subscription（订阅）。对于已经结束、并非由某个人停止且有消息等待恢复的 Ticket，这种所有权同样适用。

Main Session 会收到一条跟进通知。消息由 Executor 拥有期间，Main Session 只能依照这个人的请求停止工作；accept（接单）、attach（附加）、ignore（忽略）和 requeue（重新排队）都会被拒绝。stop（停止）仍须经过 gate，其强度按下文所述的跟进强度确定。

### 交还和释放跟进消息

当一条消息要求的工作超出 Ticket 的 scope，或者属于另一个 Ticket 时，Executor 会将其交还一次。Ticket 会保留自己的 Subscription。如果某个被附加的 Thread 与工作无关，Executor 会交还它在该 Thread 上拥有的消息。

只有当不再有任何 Ticket 拥有某条消息时，该消息才会进入一次新的 Eval。它的候选项中包含各 Executor 给出的理由。gate 会把它当作该 Thread 上的一条普通消息来判断，而 Main Session 可以接受它、将它附加到别处，或者忽略它。交还一条该 Ticket 并不拥有的消息不会排队任何内容，例如机器人消息，或者某个人已经发送给 Eval 的消息。

Ticket 结束时，会释放其 Executor 尚未读取或接手的跟进消息。这些消息包括从未投递给 Executor 的消息，以及在其最后一份 Report（报告）或最后一轮结束之后投递的消息，前提是 Executor 既未确认或回复它们，也未将它们交还。当不再有其他 Ticket 拥有其中某条被释放的消息时，该消息会进入 Eval。stop 只结束被停止 Ticket 的工作。

被停止的 Ticket 不会再次把自己的 stop 消息发送给 Eval，除非另一个 Ticket 曾经交还该消息。停止该 Ticket 的 Main Session 可以把消息的其余部分作为新工作接受。

某个人可以从面板把一条已有所有者的跟进消息发送给 Eval。如果 Main Session 随后又把它附加回某个活动 Ticket，Executor 会再次收到它。当没有有效判断覆盖某条消息时，面板也会提供重新评估操作。

### 仅提供上下文的 Subscription

Executor 可以关注一个相关 Thread（例如另一个 Issue 或拉取请求）以获取上下文。该 Thread 的消息会到达 Ticket，但不授予任何权限或跟进强度。那里的人员消息不会恢复已经结束的 Ticket，除非 Main Session 从该 Thread 取出一条消息并附加到 Ticket。Main Session 关于其他工作的备注也只作为上下文。

未到达任何 Ticket 的人员消息（包括某个人已经停止其 Ticket 的 Thread 上的消息）会走 Eval 路径。机器人消息是否走该路径，与其是否也投递给已订阅 Ticket 无关。

## 强度

| 强度 | 情形 |
| --- | --- |
| explicit（明确） | 名单中的人指向智能体，或在已有 Ticket 的 Thread 上继续跟进；准入表中的某个单元格设为明确请求 |
| inferred（推断） | 不在名单中的人在有 Ticket 的 Thread 上继续跟进，除非准入表中对应单元格设为 explicit；准入表中的某个单元格设为推断候选项；Source 机器人名单中的机器人指向智能体，或者其消息到达一个 Source 会接收每条消息的位置 |
| not admitted（不予准入） | 任何其他机器人的消息、准入表忽略的一切消息，以及接受模式为 `off` 时的所有 inferred 情形 |

对于不在名单中的人，即使其消息位于已有 Ticket 的 Thread 上，explicit 准入单元格也具有优先权，并且在所有接受模式下都有效。否则，他们的跟进消息为 inferred，并且在 `off` 模式下不予准入。只为获取上下文而关注的 Thread 上的消息使用准入表，而不使用跟进强度。

## 准入

每个 Source 的 Policy 都有一张准入表。表的各行是接收范围：

- **飞书：** 每个已配置的会话、机器人从中收到 @ 提及的其他会话，以及直接消息。只有飞书卡片上的 **其他群** 设为 **仅 @** 时，才会接收其他会话。
- **GitHub：** 新 Issue、新拉取请求、评论以及默认分支的 CI。

一行最多包含三个单元格。每个单元格决定一条消息会变为明确请求、推断候选项，还是不产生任何内容：

| 单元格 | 可选项 | 默认值 |
| --- | --- | --- |
| 在名单中，但未指向智能体 | inferred、ignore | inferred |
| 不在名单中，但指向智能体 | explicit、inferred、ignore | ignore |
| 不在名单中，且未指向智能体 | inferred、ignore | ignore |

只有在 Source 接收每条消息的位置，未指向智能体的消息所对应的单元格才可用，例如设为 **全部消息** 的飞书会话，或开启了“接收全部”开关的 GitHub 范围。CI 结果没有发送者，因此其所在行只提供最后一个单元格。机器人消息使用机器人名单，而不使用这些单元格。

把“不在名单中但指向智能体”的单元格设为 explicit，就能允许该范围内的任何人通过提及智能体来请求工作。这适用于专门的支持会话。inferred 候选项仍取决于接受模式。跟进消息通常绕过这张表，但 explicit 单元格仍会授予 explicit 强度。

准入表是 Policy version（策略版本）的一部分。削弱一个单元格不会立即停止依据它接受的 open Ticket；这些 Ticket 恢复前重新验证 Mandate 时，变更可能会撤销其 Mandate。

### 机器人和自动化评审者

宿主程序把 GitHub App、登录名以 `[bot]` 结尾的账户以及飞书机器人识别为机器人。Source 可以列出 `dependabot[bot]` 等机器人，使其消息能够成为 inferred 候选项。这些机器人必须指向智能体，或者在一个会接收每条消息的范围内发帖。它们不能发出明确请求，也不能停止 Ticket。

使用普通账户的自动化评审者，在宿主程序看来属于“人”。它的评论会到达已订阅 Ticket 并生成跟进通知。团队提示词文本必须把此类账户标明为自动化评审者。

## 路由候选项

Main Session 使用 `orchestrator_route` 路由 explicit 候选项。一次调用可以包含多个 accept、attach、stop 或 ignore 决策。每一项都独立处理：某一项被拒绝或缺少字段，不会阻止其他项运行。

inferred 候选项通常需要完整 assessment（研判）。但有一个捷径：如果其卡片显然没有涉及任何已启用规则，例如普通聊天或无关讨论，Main Session 可以直接忽略它。Decision 会记录 `ignoredFromCard`，以区别于基于规则的 assessment。Main Session 会读取其 Policy 提示词段落中的已启用规则。

接受 inferred 候选项始终需要 assessment。对于 gate 未准入为 explicit 的 Trigger，直接 accept 会被拒绝。

## 接受模式与规则

接受模式是 Policy 的一部分：

| 模式 | 效果 |
| --- | --- |
| `off` | 任何 inferred 内容都不会成为候选项，例如未指向智能体的消息、机器人的消息，或不在名单中的人的跟进消息 |
| `observe`（默认） | 对 inferred 候选项进行 assessment；正向 assessment 会记录为 ignore，并标记“would accept”，但不会实际接受任何内容 |
| `auto` | 对 inferred 候选项的正向 assessment 会接受它 |

明确请求在每种模式下都有效。应先从 `observe` 开始，在审阅已记录的 Decision 后再切换到 `auto`。每次 assessment 都会对每条已启用规则恰好判断一次，无论规则是否匹配。主动 accept 至少需要匹配一条规则。

每条规则描述一种主动工作。Ticket 的 Mandate 会记录匹配的规则，其 Executor 会收到这些规则的名称和说明。

对于该 Ticket，某条规则的流程和沟通要求会覆盖默认设置。静默规则可以禁止发送确认；评审规则可以指定合并前所需的评审者及其批准。适用于每个 Ticket 的要求应放在团队提示词段落中，而不是规则里。

## Policy 版本

规则、接受模式以及每个 Source 的 Policy 共同构成 Policy version。每个 Mandate 都会记录自己被接受时所依据的版本。

版本变化会丢弃正在运行的 Eval，并再次排队其 Trigger。它还会向每个受影响的活动 Ticket 发送一个 policy-changed Input（策略变更输入）。该 Input 会说明是否发生了以下情况：

- 某条匹配规则发生变化（包括其新文本），或者不再适用；
- 请求者可能已不能再启动工作；或者
- 主动工作不再被接受，例如模式从 `auto` 变为其他模式。

不受影响的 Ticket 不会收到通知。该变化不会立即撤销活动 Ticket 的 Mandate。

Source 配置与 Policy 相互独立。Source 配置控制什么内容进入系统：读取哪些会话，以及某个范围接收所有消息还是仅接收提及。Mandate 会记录其 Source 和接收范围。恢复工作要求 Source 仍在监听该 Thread，但不要求 Source 仍接收那里发出的每条消息。

Source 关闭期间，回复会等待。如果 Source 不再监听回复的目标位置，则会丢弃这些回复。

对 Executor 如何处理自身结果的限制（例如何时可以合并）并不决定谁可以授权工作。它属于智能体指令，而不属于 Policy。

## 恢复与停止

已经结束的 Ticket 会保留其 Mandate。某个人在其自有 Thread 之一发送消息时，可以在不经过新 Eval、也不产生新 Decision 的情况下恢复同一项工作，无论消息是谁发送的。机器人和 CI 不会唤醒已结束的 Ticket。Executor 会判断请求是否符合 scope；如果不符合，则结束本轮处理。

只有三种操作会改变 Mandate：accept 创建它，某个人的 stop 撤回它，重新验证失败则撤销它。被某个人停止的 Ticket 会保持 ended 状态，并且不再接收任何内容。要在那里请求工作，需要一次新的 accept。

### 恢复前重新验证

Source 必须仍在监听原始 Thread。其余检查取决于 Mandate 的依据：

- explicit 跟进产生的 Mandate 可以通过。
- inferred Mandate 要求模式为 `auto`，且其匹配的规则仍处于启用状态。
- 由准入表单元格准入的 Mandate，在当前准入表和发送者成员身份下，必须仍能获得至少与原来一样的强度。因此，把发送者移出名单可能会撤销通过“名单中发送者”单元格接受的 Mandate。
- 机器人的 Mandate 要求该机器人仍在 Source 的机器人名单中。inferred 准入表 Mandate 和机器人 Mandate 还要求模式为 `auto`，且匹配的规则仍处于启用状态。
- 其他 Mandate 要求发送者仍在 Source 的允许名单中。

如果重新验证失败，Ticket 会保持 ended 状态，并且不会接手任何等待中的消息。每条消息都按未到达任何 Ticket 处理；如果没有其他 Ticket 拥有它，则进入 Eval。Main Session 不会被告知该消息曾到达 worker。处理暂停之后也遵循相同规则。把消息附加到该 Ticket 的操作会被拒绝；继续工作需要一次新的 accept。

- **某个人在 Thread 中说“停止”属于普通 Trigger，** 由 Eval 决定是否 stop。Executor 不能声明某个人要求它停止。
- **在面板中执行 Stop 属于命令。** 它直接作用于 Ticket，并记录为手动停止。
- **等待条件属于 Source。** 例如“连续 N 小时没有负责人”这样的条件，应由某个 Source 自行等待并再次检查；Eval 永不等待。

## Eval 未完成时

时间限制从候选项到达 Main Session 时开始计算。等待投递所花费的时间不计入限制，从未送达的候选项也永不过期。

过期的 Eval 会重新排队其 Trigger，等待再次尝试。连续重试两次后，第三次过期会记录为 `unavailable`。assessment 失败也会记录为 `unavailable`；后续 Trigger 可以启动新的 Eval。Policy 变化，或基于过时 Policy 作出的决定，会记录为 `unavailable`，并立即在当前版本下重新排队该批次。

`evals` 健康状态项会报告过去一小时内尚未解决的 unavailable Decision。`scripts/dsh-superagent status` 会包含该错误。

仅当 unavailable Decision 不到 24 小时、仍是其 Thread 上最新的 Decision、尚未被关闭，并且该 Thread 既不在队列中也不在评估中时，面板才会请求人工关注。某个人可以重新评估该 Trigger，或关闭这个问题。
