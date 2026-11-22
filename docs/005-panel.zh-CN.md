# 005 面板

[English](005-panel.md)

在 DeepSeek Harness Web 侧边栏中打开 **Superagent** 来监督 agent。面板会优先显示需要人处理的工作，其次是系统健康状况和历史记录。本文建立在 [000 理念](000-philosophy.zh-CN.md) / [English](000-philosophy.md) 至 [004 Prompt](004-prompts.zh-CN.md) / [English](004-prompts.md) 的基础之上。

## 三个问题

打开面板时，面板会依次回答三个问题：

1. 现在有什么事情需要我处理吗？
2. 系统是否健康，并且正在做正确的事情？
3. 一项工作的历史记录是什么——从 Trigger 到 Eval，再到 Ticket？

## 标签页

各标签页遵循工作流顺序：**我的任务（My work）**、**概览（Overview）**、**来源（Source）**、**触发器（Trigger）**、**评估（Eval）**、**执行（Execution）** 和 **设置（Settings）**。在仓库和账号设置成功之前，Overview 会显示缺失的内容，并链接到相关设置。

| 标签页 | 显示内容 |
| --- | --- |
| 我的任务 | 每个 Ticket 按阶段落在五列之一：待我参与、进行中、待评审、阻塞、已完成，并可按来源筛选。列由阶段推导，不能手工拖动 |
| Overview | 需要处理的 Ticket、system problem、过去 24 小时的 activity count，以及 Executor load。每个区块都链接到其详情页 |
| Source | Source 状态、设置问题和非零计数。被过滤的 Trigger 和被丢弃的消息使用与 Overview 相同的 24 小时时间窗口 |
| Trigger | 按“已订阅（Subscribed）”“评估中（Evaluating）”“24 小时内的新 Trigger（New Triggers in 24 h）”或“所有 Thread（All Threads）”筛选的 Thread。每个 Thread 按从新到旧显示其 Trigger、Decision 和 Subscription |
| Eval | Decision 及其原因和匹配的规则 |
| Execution | Executor 状态、“暂停处理（Pause processing）”，以及按“开放（Open）”“待处理（Pending）”“工作中（Working）”“等待 Trigger（Waiting for a Trigger）”或“已结束（Ended）”筛选的 Ticket。Ticket 详情显示 action、authorization、等待中的 Input、Subscription 和 Assignment |
| Settings | Source、Eval、Execution、Prompt 和 Deployment。每个分组都包含其保存历史 |

### 查看单条记录

被丢弃的消息会链接到其 Ticket；如果没有 Ticket，则链接到其 Thread。Source 页面会说明是它的 conversation 已消失，还是 Source 已停止监听。

仍由 Executor 负责的人工 follow-up 会被标记为 **已交付到 Ticket（Delivered to Ticket）**，且没有 Eval。Thread 还会显示交还原因和仅用于上下文的 Subscription。**重新评估（Evaluate again）** 可以把该 follow-up 发送到 Eval，或者重试一个没有有效 judgement 的 Trigger：被其 Source 过滤、Eval 不可用，或消息虽已交付但既没有非 stop Decision 也没有 Executor acknowledgement。

Ticket 详情会显示发起它的 Trigger、Decision 及其原因、scope 和 Policy version。Assignment 和次要详情折叠在立即可执行的 action 下方。对于 Input 交付失败，或因 `blocked` 或 `failed` Report 而等待人工处理的 Ticket，可以使用 **重试（Retry）**。已结束 Ticket 会显示 **Pull request 已合并（Pull request merged）** 或 **已被人停止（Stopped by a person）** 等结果。

## 设置分组

- **Source：** 每个 Source 对应一张 card，其中包含开关、字段和经过验证的账号事实。GitHub 还提供 receive-all 开关，用于接收新的 Issue、pull request、comment 和 default-branch CI。轮询和读取上限位于 Advanced 下。
- **Eval：** 首先显示 Policy version 和规则，其次是 **在每个 Source 上（On each Source）** 和 Eval 设置。每个 Source 标签页都包含 allowed list、membership sync、admission table 和 bot list。同步会在启动时以及点击 **立即同步（Sync now）** 时运行。admission table 会区分 receiving scope、sender membership，以及消息是否指向 agent。Eval 设置用于选择 accept mode、timeout 和 assessment model。
- **Execution：** worker model、concurrency、directory root、prepare command 和 blocked command。点击一个可用 variable 会将其插入 prepare command。
- **Prompt：** **编辑（Edit）** 用于更改团队 section、内置 part 和 skill。**完整 Prompt（Full prompt）** 显示组装后的文本，并将其与已保存文本或默认内容进行比较。**历史（History）** 列出各个 version。被编辑过的内置 part 会标记为已更改，并且可以重置；template 会列出其必需的 placeholder。

  如果升级改变了某个已被 override 的默认内容，面板会把它标记为 **默认内容已更新（Default updated）**。面板会在团队文本上方比较新旧默认内容。如果未记录旧的默认内容，则改为比较团队文本与新的默认内容。可以选择 **保留我的文本（Keep my text）** 或 **使用新的默认内容（Use the new default）**。已移除 part 的 override 会列在标签栏下方，并在下次保存时被丢弃。
- **Deployment：** 显示启动问题并提供 **再次检查（Check again）**，同时显示 state directory 和 machine limit。已保存的 limit 无需重启即可生效。DeepSeek Harness Plugin Manager 也会显示同一个页面。

## 搜索

页眉搜索可以按文本、id、飞书 message id 或已存储链接（例如 GitHub comment URL）查找 Trigger。如果原始消息中缺少某个飞书链接，则只有在当前进程生命周期内 host 读取过该链接之后，它才可以被搜索到。

搜索还可以通过 `#12` 或 GitHub URL 等引用查找 Thread，并可以按标题或匹配的 Thread 查找 Ticket。

## 原则

1. **聚焦重要事项。** 每个元素都必须回答三个问题之一，否则就应被移除。只有当一个数字会改变监督者的行动时，才显示该数字。
2. **定义精确。** 类别必须拥有可检查的定义，彼此互斥并且覆盖所有情况，正如 Ticket 阶段一样。标签应说明某一行正在等待谁、需要什么，而不是显示内部状态码。
3. **每个概念只有一个归属位置。** Source 状态属于 Source；Thread 和 Trigger 属于 Trigger；Decision 属于 Eval；Ticket 属于 Execution。设置按其配置的概念分组。Overview 负责汇总这些页面并链接到它们，而不是成为另一个详情视图。
4. **遵循领域结构。** 面板使用领域术语。内部 identifier 只出现在折叠详情中；如果 identifier 可以解析成名称，就用名称代替它。
5. **状态真实。** 计数必须等于它所链接列表的长度，任何状态都不得与其他事实矛盾。
6. **默认安静。** 健康状态不占用额外空间。问题必须可操作；一次性的网络错误还不足以构成问题。需要人处理的行应直接提供相应 action。页面说明保持为一句话，更多细节放在 `(?)` tooltip 中。破坏性 action 需要确认。
7. **控件一致。** 使用 DeepSeek Harness 的 design token 和 control behavior。同一种信息在整个面板中应具有相同的外观。每个设置区块只有一个 save bar，并且仅在存在更改、正在保存或保存失败时可见。
