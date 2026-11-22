# 企信渠道（IM Source）技术方案

本文件是企信渠道的设计与维护基线：后续改动先改这里，再改代码。文中 `src/...` 均指本仓库路径。

- 状态：设计定稿，未开工
- 适用仓库：`sizuoyi00/dsh-superagent-prototype`
- 相关文档：`docs/001-domain.zh-CN.md`（领域）、`docs/002-authorization.zh-CN.md`（授权）、`docs/003-execution.zh-CN.md`（执行）、`docs/005-panel.zh-CN.md`（面板）、`docs/007-architecture.zh-CN.md`（架构）

---

## 1. 目的与范围

把企信（纷享 IM）的往来消息变成 superagent 的 Trigger，让既有链路完成"接消息 → 分拣 → 建单 → 干活 → 回话"。

**做**：一个新的 Source kind（`im`），加上它的 Trigger 映射、Channel、读资源、Policy 片段。

**不做**（每一条都会给设计加概念或加噪声）：

- 不新建消息队列、任务库或第二份状态；
- 不让 worker 直接对企信说话（对外只有一个声音，见 §7.8）；
- 不搭 webhook 服务端：企信只有拉取能力，Source 轮询即可，与 GitHub/飞书同构；
- 不做"一条消息拆多张工单"：一条消息至多一张单，多个诉求在单内处理、由 root 在回复里拆问；
- 不在首版引入"执行器角色清单"和"小队绑定"（见 §7.7）。

---

## 2. 设计原则（对齐 superagent 理念）

1. **只加 Source，不加概念。** 企信是又一个事件来源，"该不该接、谁来做、做完怎么回"全部落在现有概念里：Eval、Ticket、Mandate、Channel、Policy。
2. **建单只有一个点。** 就是 Eval 的 accept。放在 root 或 worker 都会绕过授权与审计。
3. **拉取不参与判断。** Source 只做"拉、去重、游标、监听范围"，它没有判断权，也不建单。
4. **一个声音。** worker 只交报告；root 决定要不要说、说什么、在哪说。
5. **默认安静。** 被 ignore 的消息不通知任何人；worker 干活期间不产生中间消息。
6. **行为写进提示词。** 分类口径、升级条件写在规则与技能里，不写成设置项。

---

## 3. 总览：谁在哪个进程里

```
┌───────────────────────────  dsh-superagent 服务（单进程，profile: superagent）───────────────────────────┐
│                                                                                                          │
│   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐                               │
│   │ GitHub 轮询  │   │ 飞书 轮询    │   │ 定时 循环    │   │ 企信 轮询 ★  │   ← Source 循环都在本进程内   │
│   └──────┬───────┘   └──────┬───────┘   └──────┬───────┘   └──────┬───────┘     没有独立守护进程        │
│          └──────────────────┴──────────────────┴──────────────────┘                                      │
│                                     │ Trigger（幂等 id）                                                 │
│                                     ▼                                                                    │
│   ┌─────────────────────────────────────────────────────────────────┐                                    │
│   │ Engine：Thread 扇出 → Eval（gate + 评估）→ Decision → Ticket    │                                    │
│   └───────────────┬─────────────────────────────────────────────────┘                                    │
│                   │ Assignment                                                                            │
│                   ▼                                                                                       │
│   ┌───────────────────────────┐        ┌──────────────────────────┐                                      │
│   │ Executor：worker-<ticket> │        │ root（主 Session）       │                                      │
│   │ 独立工作目录 / 技能 / 子代理│ ─报告→ │ 组织回话 / 结构化提问    │                                      │
│   └───────────────────────────┘        └───────────┬──────────────┘                                      │
│                                                     │ Channel.send（幂等）                                │
│   ┌─────────────────────────────────────────────────▼────────────────┐                                   │
│   │ Store（SQLite）：Thread / Trigger / Decision / Ticket / Outbox    │                                   │
│   └──────────────────────────────────────────────────────────────────┘                                   │
└───────────────────────────────────────────────┬──────────────────────────────────────────────────────────┘
                                                │ sharecrm CLI（本机已登录，AI 身份）
                                                ▼
                                        【企信服务器】

面板：DSH Web GUI → Superagent（来源 / 触发 / 评估 / 执行 / 我的任务）
```

要点：**新增企信渠道 = 在这个进程里再挂一个循环**，不新增端口、进程或部署单元；重启服务即加载。

---

## 4. 端到端流程（单条消息）

```
【企信服务器】
     │ (1) sharecrm im message list（每会话增量，每 pollSeconds 一次）
     ▼
┌────────────────────────────────┐
│ 企信 Source（常驻轮询）         │  负责：拉取 / 去重 / 游标 / 监听范围
│ · 游标 im-history:<chatId>      │  不做：判断、建单、发消息
│ · Trigger id 幂等               │  丢弃：机器人自己发的消息
└───────────────┬────────────────┘
                │ (2) 每条新消息 → Trigger（source=im, actor=发送人, addressed?）
                ▼
┌────────────────────────────────┐
│ Trigger → Thread               │  Thread = <chatId>:<rootMessageId>
│ 话题 = 首条消息 + 引用链        │  引用了某条 → 归入被引用消息所在话题
└───────────────┬────────────────┘
                │ 该 Thread 已有在办工单？
                ├──── 是 ──────► (3a) 作为上下文投递给工单 → 工单被唤醒续做
                │                     （不走 Eval，不新建单）
                │ 否
                ▼
┌────────────────────────────────┐
│ Eval · 闸门 gate                │ (4) 发送人在允许名单吗？
│                                │     点名了机器人吗（@ / 私聊 / 引用机器人）？
│                                │     会话在监听范围吗（仅 @ / 全部）？
└───────┬────────────────┬───────┘
        │ 不满足          │ 满足
        ▼                ▼
┌──────────────┐  ┌────────────────────────────────┐
│ Decision =   │  │ Eval · 评估（读有界上下文）     │ (5) 这是不是一件可执行的活？
│ ignore       │  └───────┬────────────────┬───────┘
│ 只留痕，      │          │ 不接受          │ 接受
│ 不打扰任何人  │          ▼                ▼
└──────────────┘   ┌──────────────┐  ┌────────────────────────────────┐
                  │ Decision =   │  │ Decision = accept              │
                  │ ignore       │  │ (6) 建单：Ticket + Mandate      │
                  └──────────────┘  │     sender / 策略版本 / 准入依据 │
                                    └───────────────┬────────────────┘
                                                    │ (7) 派工 Assignment
                                                    ▼
                                    ┌────────────────────────────────┐
                                    │ Executor：准备目录 → worker     │
                                    │ 技能 + 子代理干活，只写报告      │
                                    └───────────────┬────────────────┘
                                                    │ (8) 报告
                                                    ▼
                                    ┌────────────────────────────────┐
                                    │ root（主 Session）              │
                                    │ · ready        → 组织一句人话   │
                                    │ · 需人决定     → 结构化提问     │
                                    │ · blocked/failed → 说明卡点     │
                                    └───────────────┬────────────────┘
                                                    │ (9) Channel.send
                                                    ▼
                                        【企信会话（AI 身份，幂等）】
```

补充分支：

| 情况 | 结果 |
|---|---|
| 评估失败 / 超时 | Decision=`unavailable`，触发可在面板重试，不建单 |
| 工单执行中又来新消息 | 作为输入送达工单（排队），不新开单 |
| 工单已结束，同一话题再来消息 | 工单按同一 Mandate 恢复（若触发范围撤回，则不再恢复） |
| 会话被移出监听范围 | 该会话不再产生触发；未发出的回复标记 `gone` |
| 评估模式 `observe` | 只写 Decision，不建单（用于校准规则） |

---

## 5. 概念映射

| superagent | 企信世界 |
|---|---|
| Source 实例 | 一个机器人身份 + 监听会话范围 + 轮询节奏 |
| Trigger | 一条消息（含编辑版本、撤回事件） |
| Thread | 会话内一个话题：首条消息 + 引用链 |
| actor / addressed | 发送人 ID；@机器人 / 私聊 / 引用机器人消息 |
| Channel | 会话 ID + 被回复消息 ID |
| Policy | 谁能发起工作（允许名单）+ 准入矩阵（每会话：仅 @ / 全部） |
| Eval | 分拣：gate 看授权，评估看意图 |
| Ticket / Mandate | 一次被授权的活及其凭据 |
| worker | 干活方，只交报告 |
| root | 唯一对外出口 |

---

## 6. 状态与生命周期

**Ticket 阶段**（既有实现，`src/core/stage.ts`）：

```
排队(working/queued) → 执行中(working) → ┬ 待我参与(person/answer)
                                          ├ 待评审(person/review，有 PR 时)
                                          ├ 阻塞 / 失败(person/blocked|failed)
                                          └ 结束(ended)
空闲(idle)：开单但当前没有任务在跑（等待新触发）
```

**Source 健康**：`im`（轮询与消费）、`im-history`（历史补收）。失败只在面板显示，不打扰人。

**观察期**：`eval.mode = observe`，Decision 全留痕但不建单；确认规则后切 `auto`。

---

## 7. 组件设计

### 7.1 Source kind `im`

| 配置字段 | 类型 | 说明 |
|---|---|---|
| `cli` | text | 企信 CLI 路径，保存时体检账号 |
| `chats` | rows | 会话 ID + 接收模式（`仅 @` / `全部`） |
| `directMessages` | switch | 是否接收私聊 |
| `pollSeconds` | number(advanced) | 轮询间隔，默认 45，范围 10–3600 |
| `readPageSize` | number(advanced) | 读上下文每页条数 |

- 注册方式与 GitHub/飞书一致：`apply(ctx)` 里 `register(kind)` + 一个受 `AbortController` 控制的循环。
- 循环只做四件事：读配置 → 拉增量 → 生成 Trigger（`ctx.receive`）→ 推进游标。
- 未配置（无会话、无 CLI）时循环空转并报"等待配置"，不产生触发。

### 7.2 Trigger / Thread

| 字段 | 取值 |
|---|---|
| `id` | `key('im-message', messageId, updatedAt)`，编辑产生新版本，重复拉取不重复触发 |
| `source` | `im` |
| `threads` | `[{ source:'im', id: '<chatId>:<rootMessageId>' }]` |
| `actor` | `{ source:'im', id: 发送人用户 ID }` |
| `human` | 企信用户为 true；机器人/系统通知为 false（进 machineGate） |
| `addressed` | `mention`（@机器人）或 `direct`（私聊、引用机器人消息） |
| `channel` | `{ source:'im', thread: <threadKey>, address: { chatId, messageId } }` |
| `meta` | `chatId / messageId / rootId / direct / recalled / quoted` |

- 机器人自身消息在 Source 内丢弃（不进领域）。
- 撤回消息产生一条 `meta.recalled` 的 Trigger，让工单知道上下文失效，而不是当普通正文处理。

### 7.2.1 实测字段（2026-11-22 用真实消息核对，只读字段结构，未留存内容）

| 事实 | 结论 |
|---|---|
| 消息字段 | `messageId / messageTime / messageType / content / senderId / senderName / fullSenderId / messageVersion / replyMessageVo / feedTextBlockVos / private / modifiedStatus ...` |
| 引用对象 | `replyMessageVo = { messageId, messageTime, messageType, content, fullSenderId }` —— **没有 senderId**，只有 `fullSenderId` |
| 人的 fullSenderId | `E.fs.<senderId>`（146/146 与 `senderId` 一致） |
| 机器人的 fullSenderId | `BOT.<id>.fs_<hash>` |
| @ 的形态 | **只有文本**：`@` 后跟中文显示名；实测 61 处 @ 全部是「CJK+CJK」，没有结构化的 at 列表字段 |
| 会话类型 | `sessionCategory`：`D`=群聊、`S`=单聊、`C`=企业互联父会话、`OSS1`/`BOT`/`TODO`/`CRM`/`SS`=系统通道。只读群与单聊；`OSS1.*` 读取需要 `--confirm`，永不读取 |
| 历史回放（2623 条 / 5 个会话） | 命中 22 条 @我 + 1 条引用我 ≈ 0.9%；其中 11 条的 @ 在富文本/卡片消息里，内容里才有名字，可见正文只是占位符 |

由此产生的三条实现约束（已落地）：

1. 引用判定比较 `replyMessageVo.fullSenderId` 与自己的 `E.fs.<id>`，不再找 `senderId`；
2. @ 判定按显示名匹配，显示名来源依次为：配置项 `selfName`、`auth status` 的 `userName`、以及**从自己发出的消息里学习**（自己的消息带 `senderName`）；
3. 群里的普通消息默认不算点名；只有 @ 命中名字、引用我的消息、或私聊才算。

### 7.3 Channel

- `send`：`sharecrm im message send-txt`（AI 身份，自动追加来源标记），回复到触发消息。
- `allowed`：会话仍在监听范围才允许回话。
- 会话不存在/不可达 → 返回 `gone`；宿主标记永久丢弃，不重试。
- 幂等：Outbox 按消息 id 去重（`ack:<ticket>:<input>`、`reply:<ticket>:<input>`、`notice:<ticket>:ended`）；CLI 重试不会重复发。

### 7.4 Policy

- `allowed`：允许在企信发起工作的用户（企信用户 ID），面板行编辑。
- `admission`：行 = 会话，三格默认值 —— 已列出未点名 → 推断候选；未列出 → 忽略。
- `explicit` 文案：说明什么算点名（@机器人 / 私聊 / 引用机器人消息）。
- 规则（Policy rules）推荐首批两条："群内 @所有人、抄送、例行闲聊 → 不接"；"私聊或点名且要求具体动作 → 接"。

### 7.5 Eval

1. **闸门**：`gate(trigger)` 先判授权（人 → 允许名单；机器 → 机器人名单/系统事件），不通过即 `ignore`，不进入模型评估。
2. **评估**：MasterAssessor 读有界上下文（首屏 + 触发前后若干条 + 引用目标），产出 `accept / ignore / unavailable` 与理由。
3. **建单**：`accept` 时创建 Ticket，Mandate 记录 strength / sender / 策略版本 / 准入依据。
4. **模式**：`off` 不收、`observe` 只记录、`auto` 自动建单。观察期建议 ≥2 天。

### 7.6 Ticket / Mandate

- 一张单 = 一条被接受的消息；scope 是这条消息的诉求。
- 工单订阅其来源线程：同话题后续消息作为上下文送达并唤醒工单。
- 同话题的第二个诉求不新开单；root 在回复里拆问，或由人另起一条消息形成新话题。

### 7.7 执行器：worker 绑什么

| 方案 | 落点 | 是否新概念 | 首版 |
|---|---|---|---|
| **技能分派** | prompts 的 skills：`im-support`（咨询口径）、`im-troubleshoot`（技术排查）、`im-escalate`（升级条件） | 否 | ✅ 首选 |
| **执行器属性（preset/模型）** | Ticket 携带 executor 配置，accept 时按规则选定，默认继承部署 | 否（属性） | ⏳ 需要时再做 |
| **小队绑定** | 该票固定 team preset；worker 现有 `subagent` 工具已够用 | 是 | ❌ 暂不做 |

- prompts 里加一段"按来源分派口径"：企信咨询类工单先加载 `im-support`，技术类加载 `im-troubleshoot`；这不是路由代码，而是提示词。
- worker 仍可用 `subagent` 并行处理单内多步，但不需要为此引入小队概念。

### 7.8 回话：worker → root → Channel

- worker 报告必须包含：结论、证据、需人确认点（若有）。
- root 只发一条短消息：结果 + 必要动作；实现细节留在报告/PR。
- 需要人决策 → 结构化提问（`ticket.attention`）发到原会话，不夹在长报告里。
- 禁止 worker 直接发企信：把 `sharecrm` 加入 `executor.blockedCommands`（宿主会为 worker 生成同名屏障），worker 改走读资源。

### 7.9 读资源（worker 侧）

- `threadContext`：评估用的有界窗口。
- `im/` 资源：分页读取会话历史、按 messageId 取上下文，供 worker 调查。
- 好处：worker 不需要 CLI 参数知识、不会误发消息、读取可审计。

### 7.10 面板与看板

| 页面 | 呈现 |
|---|---|
| 来源 | 企信卡片：会话表、轮询间隔、账号体检、健康 |
| 触发 | 会话 → 消息时间线；显示被过滤原因 |
| 评估 | Decision、命中规则、理由 |
| 执行 | 工单列表与详情（会话链接跳回原消息） |
| 我的任务 | 五列看板，可按来源筛选（既有能力） |

---

## 8. 数据契约

| 记录 | 键 | 值 |
|---|---|---|
| 会话游标 | `im-history:<chatId>` | 最后完整覆盖的时间/消息位置 |
| 已读集合 | `im-seen:<threadKey>` | 最近处理的 messageId |
| 来源标签 | `source-labels:im` | 会话 ID → 名称 |
| Outbox 消息 id | `ack:` / `reply:` / `notice:` + ticket + input | 幂等去重 |
| Thread key | `im:<chatId>:<rootMessageId>` | 稳定，不可变更（会丢历史关联） |

---

## 9. 安全与隐私

- 发送身份是机器人（AI 身份），不冒充他人；CLI 自身限制撤回与冒充。
- worker 侧禁止 `sharecrm`，只读经 Source 资源。
- 私密内容不落仓库、不进 PR、不进日志；报告只留必要摘要。
- 允许名单为空 → 任何消息都建不了单（默认安全）。
- 群聊默认"仅 @"；"全部"按会话单独开启。

---

## 10. 失败与恢复

| 场景 | 行为 |
|---|---|
| 服务重启 | 循环重启；游标不重放；评估中/执行中的工单按既有恢复逻辑继续 |
| 拉取失败 | 健康项报错，游标不动，下轮重试 |
| 分页未覆盖完 | 不推进游标，本轮不生成触发（宁可不发，不可漏发） |
| 引用目标解析失败 | 该条不进领域，记健康错误，游标不动 |
| 发送失败 | Outbox 重试；会话消失 → `gone` 永久丢弃 |
| 模型评估失败 | Decision=`unavailable`，面板可重试该触发 |

---

## 11. 分阶段与验收

| 阶段 | 内容 | 工期 | 验收标准 |
|---|---|---|---|
| P1 | Source 只读 + `observe`：拉取、游标、Thread、threadContext、面板可见 | 3–4 天 | 两天内不重不漏；Decision 与人工判断吻合 |
| P2 | Channel + root 回话、幂等、`gone` | 2 天 | 单会话灰度，同一回复只发一次 |
| P3 | 技能（support / troubleshoot / escalate）+ prompts 分派段 | 2–3 天 | 咨询类不再走技术排查路径 |
| P4（可选） | 执行器属性：按规则选定 preset/模型 | 3–4 天 | 同类消息稳定落到同一执行器 |
| P5（暂缓） | 小队绑定 | — | 出现必须并行的工单类型再评估 |

---

## 12. 风险

| 风险 | 影响 | 对策 |
|---|---|---|
| 只有拉取、无推送 | 延迟 = pollSeconds | 45s 默认；关键会话单独调低 |
| 群消息量大 | 评估成本与噪声 | 默认仅 @；"全部"按会话开 |
| 引用/撤回语义不完整 | 上下文错 | 解析失败即停游标并报健康错误 |
| AI 身份发言的观感与合规 | 对外影响 | 先自测私聊；文案由 communication 段统一 |
| 一条消息多诉求 | 单张装不下 | 单内串行 + root 拆问 |
| 每条 @ 都跑模型 | 成本 | 规则先挡明显不接的类别；observe 期校准 |

---

## 13. 代码落点

| 位置 | 内容 |
|---|---|
| `src/sources/im.ts` | kind 定义、配置/字段/健康项、Policy 片段、注册与循环（导出 `./im-watch`） |
| `src/sources/im-trigger.ts` | 消息 → Trigger、Thread 归属、addressed 判定、撤回 |
| `src/sources/im-channel.ts` | 回话、`gone` 处理、Channel 链接 |
| `src/sources/im-read.ts` | `threadContext` 与 `im/` 分页读资源 |
| `src/kv.ts` | 新增 `im` 键族（游标、已读集合） |
| `cordis.patch.yml`、`package.json`、`tsdown.config.ts` | 插件行与构建入口 |
| `tests/im-*.spec.ts` | Trigger 映射、游标与去重、Channel 幂等与 gone、admission |
| `docs/001`、`005`、`007`（中英） | 来源清单、面板页、模块表与测试表 |

**核心零改动**：`src/core`（Engine / Eval / Ticket）不动。

---

## 14. 待定事项

1. 首版监听范围：只开私聊 + 指定群"仅 @"，还是也开"全部消息"？
2. 观察期时长：2 天是否足够（与 multica 同期记录对照）？
3. P4 是否现在排期（咨询与技术排查用不同模型/工具集）？

---

## 15. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-11-22 | 初稿：链路、组件、数据契约、分期与验收 |
