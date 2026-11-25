# SuperAgent Research Document Restructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把现有 SuperAgent 调研重构成一份可连续阅读的主报告、一份独立 Multica 专题和一份状态准确的操作手册，同时保留概念、实际调用链、源码证据与中英文引用。

**Architecture:** 主报告使用“问题—定义—产品—领域模型—业务流程—设计原理—源码实现—边界—对比—落地”的叙事骨架；Multica 专题承接其版本、控制面、daemon/runtime、案例与 DSH bridge；操作手册只维护可执行步骤。代码实现部分用统一配色的 Mermaid 业务流程图、源码流程图和时序图表达，详细函数链进入主报告附录 A。

**Tech Stack:** Markdown、GitHub Flavored Markdown、Mermaid、TypeScript 文档测试、pnpm、Vitest。

**Workspace note:** 当前正式报告、操作手册和中文镜像是现有工作区中的未提交交付物。为保留这些权威内容，本计划在当前工作区执行，不另建无法继承未提交文件的 worktree；所有编辑只作用于下列明确文件。

---

## 文件职责

- Create: `docs/multica-research.md` — Multica 独立调研、源码链路、案例、DSH bridge、版本与隐私边界。
- Rewrite: `docs/dsh-superagent-research.md` — SuperAgent 主报告；概念和业务流程优先，源码作为证据，附录保留详细调用链。
- Modify: `docs/dsh-superagent-operation-guide.md` — 阅读路线、当前环境状态和少量去重链接。
- Modify: `task_plan.md` — 阶段 11 状态与验收结果。
- Modify: `findings.md` — 记录重构后的职责边界、内容迁移和复核发现。
- Modify: `progress.md` — 记录实施、审阅与验证结果。
- Verify only: `tests/docs.spec.ts` — 运行既有文档测试；除非新文档暴露真实测试缺口，否则不修改。

### Task 1: 建立迁移清单和验证基线

**Files:**
- Read: `docs/dsh-superagent-research.md`
- Read: `docs/dsh-superagent-operation-guide.md`
- Read: `docs/superpowers/specs/2026-11-03-superagent-document-restructure-design.md`
- Modify: `findings.md`
- Modify: `progress.md`

- [x] **Step 1: 保存现有结构与规模**

Run:

```bash
wc -l docs/dsh-superagent-research.md docs/dsh-superagent-operation-guide.md
rg -n '^#{1,4} ' docs/dsh-superagent-research.md docs/dsh-superagent-operation-guide.md
```

Expected: 主报告约 1,677 行、操作手册约 1,017 行；Multica 深挖位于主报告 6.4，详细调用链位于第 8 节。

- [x] **Step 2: 建立必保内容清单**

在 `findings.md` 记录以下迁移目的地：

```text
主报告正文：定义、产品、完整领域模型、业务主流程、四组设计思想、实现总览、可靠性/安全、完成度、简化竞品、落地建议
主报告附录 A：启动、Source 摄取、准入、accept、Worker、follow-up、Report/Outbox、人工操作、恢复/关闭
Multica 专题：三类版本证据、领域对象、queue/claim/lease、daemon/runtime、terminal report、Squad、Wakeup、三个案例、DSH bridge、本机去敏实证
操作手册：安装、配置、运行、排障、备份、恢复和扩展
```

- [x] **Step 3: 运行修改前基线验证**

Run:

```bash
pnpm exec vitest run tests/docs.spec.ts
pnpm typecheck
pnpm build
git diff --check
```

Expected: 文档测试 7/7、typecheck 和 build 通过、无空白错误。若结果不同，记录到 `progress.md`，不得把既有失败归因于本轮。

### Task 2: 生成独立 Multica 专题

**Files:**
- Create: `docs/multica-research.md`
- Read: `docs/dsh-superagent-research.md:265`
- Read: `/home/sizuoyi/multica-src/multica`
- Modify: `findings.md`

- [x] **Step 1: 写专题开头和证据边界**

必须明确：

```text
官方源码 checkout：890628511e423864d21c694231277805ce9f113c
本机已安装二进制：0.4.42@76f59f5f1
旧公开文档基线：仅用于说明当时公开能力
许可：source-available，不写成传统开源产品
隐私：只保留版本、数量级和目录/运行形态，不披露标识、正文、token、配置值或进程参数
```

- [x] **Step 2: 按产品阅读顺序写主体**

章节固定为：一句话结论、产品形态、核心概念、完整业务流程、底层控制面、Squad/Wakeup、可靠性与安全、本机去敏实证、三个案例、DSH bridge、与 SuperAgent 对比、选型与组合建议、来源与限制。

- [x] **Step 3: 加入 Multica 主流程图和运行时序图**

流程图必须表达：

```text
Issue/Comment/Assignment
→ TaskService enqueue
→ PostgreSQL queue
→ WS hint / HTTP poll
→ claim + prepare lease
→ finalization + task token
→ daemon workdir/worktree
→ runtime backend / external CLI
→ durable terminal report
→ timeline/review/retry
```

时序图必须区分 Web/API、Service、PostgreSQL、daemon、runtime backend、外部 Agent CLI，并标出 queued → dispatched → running → terminal 状态转换。

- [x] **Step 4: 保留 DSH bridge 的真实协议**

写清 `dsh --profile multica --stdio`、protocol v1 JSONL `execute`，以及 `ready/session/text/thinking/tool_call/tool_result/usage/result` 事件映射；明确 adapter 已在 Go 侧存在，但 DSH profile bundle 仍需外部安装。

- [x] **Step 5: 自检专题边界**

Run:

```bash
rg -n 'token|secret|workspace_id|issue_id|task_id|person|用户姓名' docs/multica-research.md
rg -n '^#{1,4} ' docs/multica-research.md
```

Expected: 只有概念性 token/task_id 等术语，不含本机实例值或人员信息；章节顺序符合设计。

### Task 3: 重写 SuperAgent 主报告

**Files:**
- Rewrite: `docs/dsh-superagent-research.md`
- Read: `docs/000-philosophy.zh-CN.md`
- Read: `docs/001-domain.zh-CN.md`
- Read: `docs/002-authorization.zh-CN.md`
- Read: `docs/003-execution.zh-CN.md`
- Read: `docs/004-prompts.zh-CN.md`
- Read: `docs/007-architecture.zh-CN.md`
- Link: `docs/dsh-superagent-operation-guide.md`
- Link: `docs/multica-research.md`

- [x] **Step 1: 建立新骨架**

按设计稿固定 17 个主体部分：执行摘要、为什么需要、定义与边界、产品形态、核心概念、完整业务流程、四组设计思想、架构与源码、可靠性/安全/人工监督、完成度与适用边界、竞品与 Multica、试点建议、FAQ、结论、来源、研究限制、附录 A。

- [x] **Step 2: 把概念放到源码之前**

在首次使用前解释 Source、Trigger、Thread、Channel、Correlation、Policy、Gate、Assessment、Decision、Mandate、Scope、Strength、Ticket、Assignment、Subscription、Input、Report、Attention、Disposition、Main/Worker Session、Effect、Outbox、receipt、idempotency、retry、recovery。

- [x] **Step 3: 加入领域关系流程图**

图中必须可见三条路径：

```text
主路径：Source → Trigger → Gate/Assessment → Decision/Mandate → Ticket/Assignment → Worker → Report → Effect/Outbox → Channel
后续消息：同一 Thread → Subscription → Ticket Input → Worker
人工介入：Attention/Panel → retry/stop/reevaluate/pause
```

使用统一配色区分外部系统、持久领域对象、模型 Session、可靠队列和人工动作。

- [x] **Step 4: 写一次完整业务流程**

用一个 GitHub explicit 请求从评论进入到 PR/回复返回原 Thread，随后补充 inferred observe 和 follow-up 两条分支。业务流程不出现函数名。

- [x] **Step 5: 重写架构与源码章节**

按“宿主与启动、事件接入、决策控制、执行隔离、模型运行、可靠交付、恢复”组织。每节包含目的、例子、机制、源码入口和限制。

- [x] **Step 6: 加入源码流程图**

源码流程图必须清晰区分：

```text
Source adapter / intake transaction
Engine + deterministic gate
Main Session assessment
accept transaction
Effect runner + Worker launcher
DSH Worker Session / tool loop
report relay
Outbox sender / external Channel
```

图中标出 `[TX]`、`[Effect]`、`[DSH]`、`[EXT]` 四类边界，并说明 SQLite 是业务状态真相，Session 是执行载体。

- [x] **Step 7: 加入函数级时序图**

使用 `sequenceDiagram` 和分段背景，覆盖下列链路；连续图使用 A1/A2/B/C 主索引，不重复显示容易混淆的跨图步骤号：

```text
Source event → intake → gate → assessment → accept transaction
→ launch effect → Worker Session → tools/subagent/job
→ report → Main relay → Outbox → original Thread
```

必须在图中表现 duplicate/filtered 分支、explicit/inferred 分支、observe 不执行、follow-up 绕过重新 Eval 但不扩大授权、delivery 失败重试。

- [x] **Step 8: 把详细函数链迁入附录 A**

保留现有第 8 节中影响语义的函数入口、事务边界、异步边界和恢复分支；删除正文里的逐函数重复。附录按启动、Source、准入/accept、Worker、follow-up、投递、人工操作、恢复排列。

- [x] **Step 9: 压缩 Multica 对比**

Multica 只保留 80–120 行且不超过正文 10%，内容仅含定义、产品、功能、流程、一个简化案例和选型结论；所有内部表、函数、版本实证和 DSH bridge 链接 `multica-research.md`。

- [x] **Step 10: 连贯性改写**

删除模板化桥接、连续英文术语和句中源码链接；每节首段直接回答标题问题，每个段落按“场景 → 概念 → 机制 → 证据”展开。

### Task 4: 修订操作手册

**Files:**
- Modify: `docs/dsh-superagent-operation-guide.md:1`
- Read: `progress.md`

- [x] **Step 1: 添加阅读路线**

顶部链接主报告和 Multica 专题，并说明本手册只负责部署、配置、运行、排障和恢复。

- [x] **Step 2: 修正当前环境状态**

状态表必须写成：Node/git/tmux/Python/gh 可用；依赖已安装；文档测试 7/7、typecheck、build 通过；全量测试既有基线 1197/1198；`dsh` 和 `lark-cli` 未安装，因此没有完成真实 DSH/飞书端到端运行。

- [x] **Step 3: 去除重复原理**

只把大段领域解释改为主报告链接；保留会影响命令安全性的解释、警告和恢复边界。

### Task 5: 主代理内容自审

**Files:**
- Review: `docs/dsh-superagent-research.md`
- Review: `docs/multica-research.md`
- Review: `docs/dsh-superagent-operation-guide.md`
- Modify: `findings.md`
- Modify: `progress.md`

- [x] **Step 1: 只读标题和首段**

检查不看正文是否仍能复述：问题、定义、产品、概念、流程、原理、实现、边界、对比、落地。发现跳跃立即改写。

- [x] **Step 2: 检查概念先后顺序**

Run:

```bash
rg -n 'Source|Trigger|Mandate|Ticket|Effect|Outbox|Subscription|Correlation' docs/dsh-superagent-research.md
```

Expected: 每个核心词的定义早于源码细节和首次复杂使用。

- [x] **Step 3: 检查篇幅比例**

统计主报告 Multica 章节和源码实现正文的行数。Expected: Multica 80–120 行且不超过正文 10%；源码实现正文 180–260 行且不超过正文 20%，附录另计。

- [x] **Step 4: 检查事实与版本**

逐项确认官方愿景、SuperAgent 当前源码、Multica 新源码、本机旧二进制和分析推断没有互相代替；确认 Multica 写为 source-available。

- [x] **Step 5: 检查重复**

主报告与 Multica 专题之间仅重复必要结论；主报告与操作手册之间仅重复安全边界和最小产品信息。

### Task 6: 图表与链接专项复核

**Files:**
- Review: `docs/dsh-superagent-research.md`
- Review: `docs/multica-research.md`

- [x] **Step 1: Mermaid 结构检查**

确认每张图都有唯一目的、节点从左到右或从上到下、颜色含义一致、标签不堆叠、时序参与者不超过必要数量；所有 `alt/else/end` 和 `rect/end` 配对。

- [x] **Step 2: 本地链接和行号检查**

运行仓库已有链接校验方法；额外核对 `docs/multica-research.md`、主报告和操作手册的双向链接，以及全部 `../src/...#Lx-Ly` 目标。

- [x] **Step 3: 固定 commit URL 检查**

确认 Multica 源码 URL 使用 `890628511e423864d21c694231277805ce9f113c`，不把工作树路径或浮动 `main` 当作公开证据。

### Task 7: 独立审阅与最终验证

**Files:**
- Review: all three deliverables
- Modify: `task_plan.md`
- Modify: `findings.md`
- Modify: `progress.md`

- [x] **Step 1: 发起独立文档审阅**

审阅维度固定为：连贯性、概念先于源码、关键证据遗漏、三文档重复、版本/许可/隐私边界、流程图与时序图准确性。主代理逐条核验并修复 CRITICAL/HIGH/MEDIUM；LOW 中影响阅读的也修复。

- [x] **Step 2: 运行文档静态检查**

Run:

```bash
pnpm exec vitest run tests/docs.spec.ts
git diff --check
```

Expected: 7/7 通过，无空白错误。

- [x] **Step 3: 运行类型和构建验证**

Run:

```bash
pnpm typecheck
pnpm build
```

Expected: 两项均以 exit code 0 完成。

- [x] **Step 4: 校验 Shell 示例**

提取三份交付文档中的 `sh`/`bash` fenced blocks，逐块运行 `sh -n` 和 `bash -n`。Expected: 全部仅做语法检查且通过，不执行示例命令。

- [x] **Step 5: 更新规划记录**

把阶段 11 标记为 complete，记录文件、审阅修正、Mermaid 数量、链接检查和命令结果。明确全量测试是否重跑；未重跑时沿用 1197/1198 基线且不声称全量通过。
