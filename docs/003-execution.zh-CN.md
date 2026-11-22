# 003 执行

[English](003-execution.md)

本文跟踪一个已接受的 Ticket（工单）如何完成执行、交付和恢复。本文建立在 [001 领域模型](001-domain.zh-CN.md) / [English](001-domain.md) 和 [002 授权](002-authorization.zh-CN.md) / [English](002-authorization.md) 的基础之上。

## Ticket 阶段

每个开放的 Ticket 都有且只有一个阶段，该阶段取决于它正在等待什么。请从上到下读取下表；第一个匹配的行生效。

| 阶段 | 条件 | 面板标签 |
| --- | --- | --- |
| person / delivery | 向 Executor Session 交付 Input 失败；系统会在 2 秒后重试，此后的延迟时间不断翻倍，最多一分钟；交付成功、新 Assignment 或 Ticket 结束时会清除此状态 | 输入未送达（Input undelivered） |
| person / answer | 它有一个 Attention | 等待回答（Awaiting answer） |
| person / review | 最新 Report 为 `ready` | 等待审查（Awaiting review） |
| person / blocked, failed | 最新 Report 为 `blocked` 或 `failed`，并且此后尚无人的消息到达该 Ticket | 已阻塞 · 已失败（Blocked · Failed） |
| working / queued | 没有 Assignment，或存在一个待处理的 Assignment | 已排队（Queued） |
| idle | 最新 Report 为 `waiting`，或 Assignment 已结束 | 等待 Trigger（Waiting for a Trigger） |
| working | 其他所有情况 | 工作中（Working） |

`person` 阶段表示 Ticket 在没有人工输入的情况下无法继续。新的人工消息会将 `blocked` 或 `failed` Ticket 释放给其 Executor，因此它会进入下一个匹配阶段，通常是 `working`。

一个 `idle` Ticket 已经结束了当前轮次，并且没有尚未回答的问题。其订阅的 Thread 上出现 Trigger 时，可以让它继续执行。

## Executor（执行器）

每个 Ticket 都会获得一个名为 `worker-<ticket id>` 的 Executor Session，以及一个以 Ticket 短名称命名的目录。这些目录在已配置的执行根目录下创建；执行根目录默认为 `<stateDir>/work`。

Executor Session 以操作员的操作系统用户身份执行命令，无需审批。其 `dsh-superagent-worker` preset 包含工作所需的工具，并会在前台 shell 命令运行 5 秒后将其移至后台 job。这样，worker 就能在下一步接收新消息，而不必等待长时间运行的命令结束。

主 Session 使用 `dsh-superagent-router`，其 shell 和 job 等待时限同样为 5 秒，但用于路由的工具集更小。Session 会保留创建时选定的 preset。Worker subagent 使用 DeepSeek Harness 的 `standard` preset。

### 后台工作与 worker slot

如果一个轮次结束时仍有 shell job 或 subagent 正在运行，Ticket 会保留其 worker slot 并继续处于工作状态。它不会被报告为等待中，主 Session 也不会收到等待 Report。已完成的 job 或 subagent 会在同一个 slot 中唤醒 Executor，并把结果交给它。只有当一个轮次结束时没有后台工作，Executor 才会正常报告等待状态。

每个轮次结束后，后台工作最多有 30 分钟完成。达到这一时限时，shell job 会被终止，Ticket 会被报告为等待中。Report 会包含 Executor 的最后留言，以及哪些 job 被终止或哪些 subagent 仍在运行。Subagent 可以继续运行。Executor 会在下一轮读取被终止 job 的结果。

移交给人时会立即释放 slot，但保留当前 Report 的效力。这适用于 `ready` Report 或提问之后（前提是此后没有其他 Input 到达），也适用于任何 `blocked` 或 `failed` Report 之后。

移交时，subagent 会停止。shell job（例如为审查而提供的服务器）可以继续运行，直至 Assignment 结束。它们不占用 slot，也不受 30 分钟时限约束，即使在后续轮次之后也是如此。其完成不会唤醒 Executor；Executor 会在下一轮读取结果。

人也可以直接在 Executor Session 中写入内容来启动一个轮次。其后台工作遵循相同规则。

Assignment 结束时，其 shell job 会被终止，但不会唤醒 Session。其 subagent 会被释放，而这些 subagent 完成后可能触发的唤醒轮次会被丢弃。替代它的新 Assignment 及其等待中的 Input 会在上述关闭过程完成后开始。

在 DeepSeek Harness 进程内停止或重启插件时，会使用相同的关闭路径。尚未进入 Session 历史记录的 Input 会被保留。关闭过程会为每个 worker 的后台工作等待最多 10 秒；进程重启会直接终止这些工作。一个在忙碌时被中断的 Assignment 会附带恢复说明重新启动。

Worker subagent（包括嵌套 subagent）使用 DeepSeek Harness 的 `standard` preset，并继承 worker 的权限。它们仅保留 worker 被允许使用的工作工具，并在 Ticket 结束时失去这些工具。在 `standard` 下，shell 命令运行 60 秒后会移至后台。Subagent 结束时，其 job 会被终止。

### 准备 Ticket 目录

首次 Assignment 之前，如果 Ticket 目录不存在，prepare command 会在执行根目录中通过 `sh` 运行一次。它有十分钟的完成时限。如果没有 prepare command，worker 会从空目录开始。

命令失败会导致 Ticket 失败，并记录其输出。重试或某个人在该 Ticket 的某个 Thread 上发送消息时，系统会再次尝试准备。典型命令会使用 `git worktree` 创建 checkout。当一个 pull request 的分支最后一个路径段与 Ticket 短名称匹配时，该 pull request 属于此 Ticket。

### 并发

Ticket 从 launch 开始时就占用一个 worker slot（包括准备过程），或者从唤醒其空闲 Executor 的交付开始占用。它还会在整个活动轮次期间持续占用该 slot。

已配置的并发上限适用于这些 slot，此外还为人工消息或状态请求保留一个额外 slot。当普通 slot 已满时，此类唤醒可以使用额外 slot，并且会在有普通 slot 释放时优先占用它，然后才启动新的 launch。因此，新工作无法阻止人继续推进已有 Ticket。

其他 Input（例如 CI 结果）需要等待普通 slot。launch 会停留在 `working / queued`，直到 slot 可用。各 launch 并发运行，因此缓慢的 prepare command 只会延迟它自己的 Ticket。

### 执行变量

prepare command 和 Executor 指令会收到同一组执行变量。命令读取环境变量；Executor 则在其 prompt 中读取这些变量的值和说明。这些变量都不包含凭据。

| 变量 | 注册方 | 值 |
| --- | --- | --- |
| `DSH_SUPERAGENT_DIR`、`DSH_SUPERAGENT_NAME`、`DSH_SUPERAGENT_TICKET` | Executor | Ticket 的目录、短名称和 id |
| `DSH_SUPERAGENT_BLOCKED_COMMANDS` | Executor | Executor 不得运行的命令 |
| `DSH_SUPERAGENT_GITHUB_REPOSITORY` | GitHub | Source 监视的仓库，格式为 `owner/name` |
| `DSH_SUPERAGENT_GITHUB_ACCOUNT`、`DSH_SUPERAGENT_GITHUB_COMMIT_EMAIL` | GitHub | agent 账号及其 commit email |
| `DSH_SUPERAGENT_GITHUB_NUMBER`、`DSH_SUPERAGENT_GITHUB_PR_HEAD` | GitHub | 启动 Ticket 的 Issue 或 pull request；如果是 pull request，还包括它的 head ref |
| `DSH_SUPERAGENT_FEISHU_BOT`、`DSH_SUPERAGENT_FEISHU_CHAT` | Feishu | 启动 Ticket 的 bot 和 chat |

Ticket 特有的值来自其目录和发起它的 Trigger。其他值来自当前部署设置。只有面板可以更改执行环境设置；发送给主 Session 的文本无法更改已配置的 shell command。

Worker 通过 agent 账号的 `gh` 访问 GitHub，并通过 bot 的 `lark-cli` 访问飞书。以命令名调用被阻止的命令时，调用会失败。

这些 wrapper 和目录用于建立默认行为，并不构成安全边界。Worker 仍然可以通过绝对路径执行程序。

## 合并

自动合并由 **Delivery requirements** prompt 管理。host 没有任何合并专用的决策逻辑。

默认情况下，Executor 绝不会以 agent 账号启用自动合并，因为 GitHub 会把合并归因于启用自动合并的人。Delivery requirements 必须指定另一个账号的 CLI 来执行合并。如果没有指定，则由人来合并 pull request。

默认指令只允许对为该 Ticket 打开的 pull request 启用自动合并，并且要求该 pull request 已就绪、所需审批覆盖 head commit，且新增行数与删除行数之和少于 200 行。在推送另一个 revision 之前，Executor 会撤销自动合并。

没有正文的 review（例如 approval）也会作为 Trigger 到达，并可以唤醒正在等待 review 的 Executor。这些指令约束的是 agent，而不是 GitHub 的合并规则。要强制要求审批，请在 branch protection 中将其设为必需，并设置为驳回过期审批。若要强制人工合并，请省略合并 CLI 或删除自动合并段落。

## Ticket 如何结束

- **没有 pull request 时就绪：** 一个 `ready` Report 会以已完成状态结束 Ticket。
- **没有事情可做：** 如果 Executor 发现没有任何可供人采取行动的工作，例如请求无法复现或已被取代，它会报告 `dropped`。除非匹配的规则要求发送消息，否则 Ticket 会无消息地结束；之后，人若在其 Thread 上发送消息，可以恢复该 Ticket。

### Pull request（拉取请求）

一旦 Executor 报告了启动 Ticket 的 pull request，Ticket 就会跟踪它。Ticket 还会跟踪其分支所打开的每个 pull request，只要它已由 Executor 报告或被 GitHub Source 发现。重新打开的 pull request 会再次受到跟踪。

当 Ticket 打开的所有 pull request 都不再开放时，该 Ticket 完成。如果它没有打开任何 pull request，则它跟踪的所有 pull request 都必须已关闭。随后，它会以最后一次相关关闭的结果结束，同时保留其 Subscription，以便之后的人工评论能够恢复它。

在恢复、重试或恢复处理的工作尚未完成时，关闭 pull request 不会结束 Ticket。如果 Executor 已确认或回答一个自己负责的 follow-up，但此后尚未发出非 progress Report，或者读取该消息后尚未结束一个轮次，Ticket 也会继续等待。之后的 `ready` Report 会在满足相同的 pull-request 完成规则后结束 Ticket。

Chat Channel 会收到一条关于 pull-request 结果的最终通知。GitHub 已经会在 pull request 本身显示结果。移除 Ticket 对 pull request 的 Subscription，也会使 Ticket 停止跟踪该 pull request。

因此，“等待审查（Awaiting review）”指的是有 pull request 的 `ready` Report。

### Follow-up 与上下文 Thread

Executor 负责决定如何处理其 Ticket 自有 Thread 上的人工 follow-up。它会处理范围内请求，并将超出范围或属于另一个 Ticket 的请求交还。一旦某条消息不再由任何 Executor 负责，它就会成为主 Session 的候选项。除此之外，主 Session 只能在有人要求停止工作时对 follow-up 采取行动。

Session 将 Input 纳入一个 step，并在此后报告或结束轮次之后，该 Input 才算已读。Ticket 结束时，未被确认、回答或交还的未读消息会返回 Eval，如 [002 授权](002-authorization.zh-CN.md) / [English](002-authorization.md) 所述。已读但无需操作的消息（例如致谢）不会返回。

仅为上下文而跟踪的 Thread 仍会交付消息，但不会赋予 Ticket 对人工 follow-up 的所有权，也不会恢复已结束的 Ticket。这些消息可以被独立评估。

只要仍有一个存活的 Ticket 订阅某个 Thread，Source 就会轮询该 Thread；此后还会继续轮询，直到“最后一次 Trigger”与“所有订阅 Ticket 的结束时间”两者中较晚者之后两周。再往后，消息只会通过常规入口到达：GitHub notification 或飞书实时 event。

## 失败与恢复

### Executor 被阻塞或失败

当 Executor Session 报告 `blocked` 或 `failed`，或者启动失败或发生错误（这些情况会记录为 `failed`）时，该 Ticket 不会自动接收 Input。

如果是模型提供商或网络的临时性故障、HTTP 408、429 或 5xx，或者连接被拒绝、重置或超时，系统会先重试三次，重试间隔逐步增加：launch 会再次运行；轮次失败的 worker 会收到继续执行的指示；失败的 prepare command 不会再次尝试。

一旦进入失败状态，CI 和 bot 消息仍会记录到 Ticket 上，但不会被交付，也不会唤醒 Session。

其工具仍然可用，因此人可以直接在 Session 中继续工作。

失败的 launch 不会自行重试。

人工消息、之后一个既非 `blocked` 也非 `failed` 的 Report，或一次 retry，都会解除这种暂停状态。

该状态根据已存储的 Report 和 Input 推导，因此重启后仍会保留。

### 重试

当开放的 Ticket 处于 `person / delivery`、`person / blocked` 或 `person / failed` 时，可以进行重试：补救方式是创建一个新的 Assignment，由它重新启动 worker 并接收等待中的 Input。

一旦人工消息到达被阻塞或失败的 Ticket，Executor 就已经拿到该消息，因此 Ticket 会显示为工作中；如果失败的 launch 正在重新启动，则显示为已排队。此时不再提供 retry，除非交付该消息失败。

retry 会结束当前 Assignment，并在同一个 Executor Session、目录、分支和 pull request 中启动一个新的 Assignment。

Executor model 只在创建 Session 时生效；已有 Session 会保留其 model。

### 重启

正在运行的 Assignment 会以“host restarted”结束；新的 Assignment 会从最早的 Ticket 开始，并附带恢复说明，要求 Executor 在重复任何外部操作之前检查其目录、git 历史记录和 GitHub。

处于 waiting、ready、blocked 或 failed 的 Assignment 会保持原状；但如果某个 Input 在对应 Report 之后到达，它们也会重新启动。

Session、目录、Subscription、待处理消息和下述已存储工作都能跨重启保留；每个 Executor Session 将哪些消息纳入历史记录的记录也能保留。step 在认领消息之后、调用 model 之前完成这一记录：如果重启截断了一个轮次，该轮次已经接收的消息会在后续出现 Report 或轮次结束后算作已读；如果消息已被 step 认领，但在写入历史记录前被 cancel 或 error 截断，则算作未读。

retry 或 restart 会把其替代的 Assignment 已收到、但 Executor Session 尚未接收的消息再次交给新 Assignment；cancel 或被截断的 step 可能已经丢弃这些消息。仍在 Session 中等待、被 restart 保留或跨 crash 持久化的副本，会在新 Assignment 的第一条消息之前被取出，因此新的交付是唯一副本。

### 已存储工作

dsh-superagent 在完成决策后要做的事情——例如把 candidate、follow-up 或 Report 中继到主 Session，启动 Assignment，或交付 Input——都会先存储，再执行。

中继或交付失败时（例如无法访问对应 Session），系统会在 2 秒后重试，此后的延迟时间不断翻倍，最多一分钟；launch 失败会导致 Ticket 失败，除非该故障是上述临时性故障。

每类工作只有在某一项连续失败三次后，才会在 overview 的 system problem 中报告错误；失败的 Input 交付会改为显示在其 Ticket 上。

发送到主 Session 的中继会保持顺序，通知同样如此；一项失败会阻塞其同类的后续项。

### Source 失败

GitHub Source 会分别读取每个 Issue、pull request 和 Thread：读取失败时，错误会保留在其 Thread 上，并在下次轮询时再次读取，同时计入 Source 的错误状态；默认情况下，Source 会在连续三次轮询失败后报告该错误；任何一次成功轮询都会重置计数。

当 agent 失去对私有仓库的访问权限时，GitHub 也会返回 404，因此 404 会被重试。

如果已收到通知的 Issue 或 pull request 持续读取失败，它会在第一次读取失败一天后被丢弃；如果 GitHub 报告其已删除，则会立即丢弃。此后它不再使轮询失败；它的 Thread 会保留错误，Source 状态会列出它。

其读取位置会停留在原处，因此之后的 notification 或对其 Thread 的轮询可以读取先前失败所遗漏的内容。

飞书 event consumer 会报告每次失败；对已订阅 topic 的轮询会把每次失败保留在其 Thread 上。

GitHub 列表或飞书 page 中格式错误的 item 会被跳过，并计入 Source 状态。

### Channel 失败

外发消息会作为已存储工作保存并发送；发送失败后会按 backoff 重试，初始间隔为 5 秒，随后翻倍，最多 300 秒。

一个 Ticket 发送到同一 conversation 的消息会按照入队顺序发出，因此它的 acknowledgement 会先于后续 answer 或 result：如果同一 Ticket 发往同一 conversation 的前一条消息尚未发送，后一条消息会等待，直到前一条连续失败三次并显示为 problem。

其他 Ticket 的消息以及不属于任何 Ticket 的消息不受其影响。

尝试失败的消息在成功发出或被撤回之前，都属于 system problem。

只有当 Source 不再监听 conversation，或者 Source 回答该 conversation 永远无法接收消息时，消息才会被丢弃；当 Source 关闭时，消息会继续等待。

对于已删除的 Issue 或 GitHub 上被锁定的 conversation，以及被撤回的飞书消息或飞书上已无法找到的消息，Source 会给出上述回答。

如果要回复的 review comment 已不存在，回复会改为发送到该 pull request 的 conversation。

被丢弃的消息会保留记录，包括丢弃时间、原因以及它所属的 Ticket，因此绝不会再次入队；被丢弃的 acknowledgement 显示为 dropped，而不是 sent。

### 暂停处理

这会停止 dispatch、新 Eval、Eval timeout、Input 交付和 reply；已经启动的 launch 会等待，直到处理恢复。

Source 会继续记录 Trigger，正在运行的 Executor 轮次也不会被中断。

人发送给已结束 Ticket 的消息会等待：暂停结束后的第一次处理会恢复该 Ticket，前提是其 Mandate 在当时的 Policy 下仍然成立。

正在进行的 Eval 不会在暂停期间过期；其 deadline 会向后顺延，时长等于暂停时长。

### 无效配置

如果已存储的 Source 配置被该 Source 类型判定为无效，则会禁用该 Source 实例。
