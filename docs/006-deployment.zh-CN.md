# 006 部署

[English](006-deployment.md)

使用本指南安装、配置和运维 dsh-superagent。本指南涵盖账户、启动检查、升级和故障排查，并建立在 [001 领域模型](001-domain.zh-CN.md) / [English](001-domain.md) 到 [005 面板](005-panel.zh-CN.md) / [English](005-panel.md) 的基础之上。

## 运行的组件

- **一个专用的 DeepSeek Harness profile**，本指南称其为 `superagent`。从 Web profile 模板创建它。它会加载 bundle，并在 `127.0.0.1` 上提供面板服务。请将它与你日常工作的 profile 分开：该插件会修改进程级的 `PATH` 和 git 设置，并且其进程需要独立重启和升级。
- **一个 Agent GitHub 账户。** Agent 通过一个仅以该账户登录的 GitHub CLI，以该账户的身份发表评论、推送分支和创建拉取请求。
- **可选：**一个用于接收聊天请求的飞书机器人。

插件配置保存状态目录和机器限制。其他所有配置都通过面板完成：在 Sources 中配置仓库和账户，在 Policy 中配置允许列表，在 Execution 中配置工作器目录和命令。

### 权限与隔离

该 bundle 为 Executor 定义了 `dsh-superagent-worker`，并为主 Session 定义了 `dsh-superagent-router`。它们会出现在 DeepSeek Harness 的 preset 列表中，但仅供 dsh-superagent 使用。不要为个人 Session 选择它们，也不要禁用它们的配置行。应用需要它们来创建和恢复自己的 Session。

在 Web UI 中打开一个空白的托管 Session 时，可能会选中该 profile 的默认 preset。dsh-superagent 会在第一轮对话前恢复其角色专用的 preset。

两个 preset 都以操作员的操作系统用户身份、使用 `danger-full-access` 运行，并从已订阅的 Thread 中读取消息。账户包装脚本会默认选择 Agent 的凭据，但并不隔离进程。工作器可以按路径执行程序，也可以读取操作员的主目录。若要实现隔离，请使用一个专用的操作系统账户，并让其中只包含 Agent 的凭据。

## 前置条件

- Node.js 22.19+ 或 24+、pnpm、git 2.32+、Python 3.8+ 和 tmux
- GitHub CLI（`gh`）2.48 或更高版本。Source 的 CLI 字段必须指向 `gh` 或 `lark-cli` 的包装脚本；宿主依赖它们的子命令和输出格式。
- github.com 上的仓库；不支持 GitHub Enterprise Server。若要为每个 Ticket 创建一个 checkout，请保留一个本地 clone，让 prepare 命令能从中添加 worktree。如果该仓库使用 Git LFS，请安装 `git-lfs`。
- 已为 DeepSeek Harness 配置好模型提供方。除非 Eval 或 Execution 设置指定了其他模型，否则 dsh-superagent 使用该 profile 的默认模型。
- 使用飞书时：`lark-cli`（已用 1.0.90 测试）以及一个启用了机器人能力的飞书或 Lark 应用

## 账户

### Agent GitHub 账户

1. 为 Agent 创建一个 GitHub 用户账户，并授予它对仓库的写权限。GitHub App 不能充当 Agent，因为 dsh-superagent 会读取该账户的通知。
2. 为它提供一个只使用其自身凭据的 GitHub CLI：

   ```sh
   mkdir -p ~/.local/bin
   cat > ~/.local/bin/gh-agent <<'EOF'
   #!/bin/sh
   GH_CONFIG_DIR="$HOME/.config/gh-agent" exec gh "$@"
   EOF
   chmod +x ~/.local/bin/gh-agent
   gh-agent auth login
   gh-agent api user --jq .login
   ```

   以 Agent 账户登录；最后一条命令会输出其 login。dsh-superagent 也以同样的方式读取 login。

### 飞书机器人（可选）

1. 创建一个具备机器人能力的自建应用。授予它接收消息事件、读取和发送聊天消息以及读取聊天成员的权限，然后发布应用版本。
2. 为机器人提供独立的 `lark-cli` 配置，将其限制为机器人身份，并创建一个包装脚本：

   ```sh
   LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-dsh-superagent" lark-cli config init --app-id <cli_…> --app-secret-stdin
   LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-dsh-superagent" lark-cli config strict-mode bot --global
   cat > ~/.local/bin/lark-bot <<'EOF'
   #!/bin/sh
   export LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-dsh-superagent"
   exec lark-cli "$@"
   EOF
   chmod +x ~/.local/bin/lark-bot
   ```

   第一条命令从标准输入读取应用密钥。请使用单独的配置目录：`lark-cli` 每个 app id 仅允许一个 profile，而你的个人配置可能已经包含了该应用的用户登录。

   宿主会拒绝可作为用户执行操作的 CLI。它会从机器人配置中读取 app id、飞书/Lark 品牌以及机器人的 `open_id`。

   两份配置共享用于保存应用密钥的钥匙串条目。若只想移除机器人配置，请删除其目录；不要运行 `lark-cli config remove`，因为这会影响共享密钥。

## 安装

在尚不存在 `superagent` profile 的机器上执行一次以下命令块：

```sh
npm install -g @deepseek-ai/dsh@0.2.1-rc.3
git clone <this repository> dsh-superagent && cd dsh-superagent
pnpm install && pnpm build
dsh superagent --from-default-profile web --dump-config > /dev/null
dsh plugin --profile superagent add "link:$PWD"
```

上面固定的版本是公开版本；其他版本必须满足 `package.json` 中的 `engines.dsh`。

第四条命令会根据 DeepSeek Harness Web 模板创建 `~/.dsh/profiles/superagent`。第五条命令会安装该 bundle。设置 `DSH_HOME` 可以迁移默认的 `~/.dsh` 目录。

只在全新安装时运行 profile 创建命令。如果该 profile 已经存在，这条命令会替换它，并删除其中的 `cordis.patch.yml`，包括机器配置。升级时不要使用这条命令。

## 机器配置

将 [examples/profile.cordis.patch.yml](../examples/profile.cordis.patch.yml) 复制到 `~/.dsh/profiles/superagent/cordis.patch.yml`，替换该文件，并替换每一个 `<placeholder>`。如果使用飞书，还要启用其中的 `dsh-superagent-feishu` 条目。`webserver` 条目用于设置面板端口。

| 键 | 必需 | 含义 |
| --- | --- | --- |
| `stateDir` | 是 | 绝对路径：数据库、锁、`worker-bin` 中的命令 shim、Agent 的 git 配置，以及默认位于 `work` 中的 Ticket 目录。升级前请备份该目录 |
| `promptMaxChars`, `admissionContextMaxPages`, `admissionContextTimeoutMs` | 否 | 可保存的最大提示词配置，以及一次评估在多长时间内读取多少页 Thread |

首次启动后，可在 **Settings → Deployment** 或 DeepSeek Harness Plugin Manager 中编辑机器限制。修改无需重启即可生效。不能在那里修改 `stateDir`。无效值或未知配置键会阻止启动；日志会指出具体的键。

## 启动与停止

```sh
scripts/dsh-superagent start
scripts/dsh-superagent status
```

`start` 会在 tmux Session `dsh-superagent` 中运行 `dsh --profile superagent`；若使用其他 profile，则 Session 名为 `dsh-<profile>`。它最多等待一分钟，直到运行时就绪或报告需要完成设置。首次运行时，它会输出缺失的设置信息。它会拒绝启动重复实例，包括从该脚本之外启动的实例。

`stop` 和 `restart` 会请求优雅关闭，并最多等待 Executor 五分钟。它们绝不会强制终止进程，也不会操作其他 tmux Session。

`status` 会输出进程 ID、健康状态和设置问题。若使用其他 profile 或端口，请使用 `--profile` 和 `--url`，或设置 `DSH_SUPERAGENT_PROFILE` 和 `DSH_SUPERAGENT_URL`。

`status`、`start` 和 `restart` 会返回以下四种退出码之一：

| 代码 | 含义 |
| --- | --- |
| 0 | 服务正常运行 |
| 1 | 服务未运行、运行了两个实例、没有响应，或其运行时报告错误；重启可能修复问题 |
| 2 | 服务正在运行，但运行时之外的某个部分（例如 Source 或 Policy 同步 `sync:<source id>`）报告错误；重启无法修复问题 |
| 3 | 服务正在运行并等待设置；重启无法修复问题 |

仍在启动的 Source 视为正常运行。因设置原因无法检查的飞书机器人也同样视为正常运行。

`status` 会在 `errors` 下返回失败的部分及其详情，并在 `setup` 下返回设置要求。`start` 和 `restart` 会逐行输出这些问题；如果服务始终无法启动，它们会以退出码 1 退出。只有主动执行 `stop` 才会暂停自动恢复。

每个 profile 都会在 `.artifacts/` 下保存日志和控制文件：

- 启动日志：`dsh-superagent-<profile>-<date>-<time>-<pid>.log`，其中 pid 属于脚本。仅保留最新 20 个日志。
- 控制文件：`control/profiles/<profile>/`，其中包含停止标记、锁和进程 ID。

打开日志中输出的 URL，然后在侧边栏中选择 **Superagent**。

### 每小时检查

请在你平时使用的 DeepSeek Harness profile 中创建每小时检查，而不是在 `superagent` 中创建。当 Agent 服务停机时，这项检查仍必须继续运行。请让该 profile 中的 Agent 使用下面的提示词创建每小时执行的计划，并填入 checkout 路径：

```text
Check dsh-superagent: run `scripts/dsh-superagent --profile superagent status` in <checkout>. Exit 0: do nothing and say nothing. Exit 2: do not restart; tell me each part under `errors` with its detail, unless you already told me about the same ones. Exit 3: do not restart; tell me what `setup` says setup needs, unless you already told me. If it reports manually_stopped: true, leave it stopped. Otherwise (exit 1) run `scripts/dsh-superagent --profile superagent --respect-stop restart`, which exits the same way: 0 means it recovered, so say nothing; 2 and 3 are reported as above; if it exits 1 or fails otherwise, read the newest .artifacts/dsh-superagent-superagent-*.log and the Troubleshooting section of docs/006-deployment.md, fix what you can, and tell me what was wrong and what you did.
```

`--respect-stop` 会保留主动停止状态。只有 `stop` 会写入该标记；`start` 会清除它。`restart` 不会写入标记，因此该检查可以恢复因关闭超时而失败的重启。

## 设置

设置必须成功，轮询和工作才会启动。Overview 会列出缺失的要求，并链接到对应设置。更改设置后会再次运行设置检查。如果你在应用外部修复了某些问题（例如 CLI 认证），请选择 **Check again**。

1. **Sources。**设置 GitHub 仓库（`owner/name`）和 Agent CLI，例如 `/home/me/.local/bin/gh-agent`。请求通常通过 Agent 账户的通知进入。提及该账户的新 Issue 或评论会在下一次轮询时到达；通过编辑现有 Issue 正文新增提及不会被接收。此时请发布一条新评论。使用飞书时，设置机器人 CLI、聊天、每个聊天的接收全部或仅接收提及模式，以及是否接收私聊消息。
2. **Policy。**两个示例规则都可以编辑或删除。在 **On each Source** 下，添加可请求工作的 GitHub 账户和飞书用户；在列表中至少有一人之前，任何请求都无法成为 Ticket。使用飞书时，可选择一个聊天作为列表同步源，在启动时和点击 **Sync now** 时同步。
3. **Execution。**设置目录根路径和 prepare 命令。要为每个 Ticket 创建一个仓库 checkout：

   ```sh
   git -C /home/me/src/widgets fetch --no-tags "https://github.com/$DSH_SUPERAGENT_GITHUB_REPOSITORY.git" "${DSH_SUPERAGENT_GITHUB_PR_HEAD:-HEAD}:refs/dsh-superagent/$DSH_SUPERAGENT_TICKET" &&
   git -C /home/me/src/widgets worktree add -b "agent/$DSH_SUPERAGENT_NAME" "$DSH_SUPERAGENT_DIR" "refs/dsh-superagent/$DSH_SUPERAGENT_TICKET"
   ```

   将个人 CLI（例如使用你自己账户登录的 CLI）列为被阻止的命令。
4. **Prompts。**设置团队段落：GitHub 披露行、评审机器人、提交作者和自动合并条件。

### 管理 API

面板使用一个本地 HTTP API，Agent 也可以调用它。`SETUP.md` 使用该 API 保存设置，服务脚本会读取 `GET state`。

向 `http://127.0.0.1:<port>/orchestrator/api/` 发送请求，并携带 `x-orchestrator-request: 1`。Host 必须是 `127.0.0.1:<port>` 或 `localhost:<port>`。缺少请求头，或 `Origin` 来自其他站点时，会收到 403。

通过 API 保存拥有与面板相同的权限。与通过主 Session 工具执行的保存不同，它们可以修改执行环境和设置账户字段。

Agent 可以依赖以下路由和字段。`src/app/api.ts` 中的其他路由服务于面板，并会随面板一同变化。

| 请求 | 响应 |
| --- | --- |
| `GET state` | 每个页面都会读取的内容：`setup`，其中包含 `problem` 和 `feishuProblem`，它们各自为 `null`，或一个包含 `place`、`code`、`values` 和 `detail` 的设置问题；设置解析出账户后还包含 `accounts`；`health`，为下面列出的每个部分提供一个条目，包含 `state`（`starting`、`ready`、`paused` 或 `error`）、`detail` 和 `at`；`load`，包含 Executor Session 的 `running`、Ticket 的 `queued` 和 `maxWorkers`；`paused`；以及 `masterId` |
| `GET settings` | `blocks`：`policy`、`eval` 和 `executor`，每项都包含其 `value` 和 `revision`；`sources`：各个 Source 实例，每项都包含 `id`、`kind`、`installed`、对应块的 `value`、`{"enabled": …, "config": {…}}` 和 `revision`，还包含该种类对应的表单，以及存在问题时的设置 `problem`；`policyVersion`；以及 `environment`，即执行环境的 `root` 和 `variables` |
| `GET sources` | 每个 Source 的状态：`state`（`missing`、`off`、`error`、`setup`、`starting`、`paused` 或 `ready`）、其各部分的 `health`、设置 `problem`、最近一天的 `stats`、当天被 `filtered` 的 Trigger，以及当天被 `dropped` 的消息（最新丢弃项在前）；每条消息包含其 `channel`、`preview`，若对应某个 Ticket，则包含 `ticket`（`id` 和 `title`），当 store 中存在时还包含 `thread`，以及 `dropped.at` 和 `dropped.reason`、`channelGone` 或 `channelIgnored` |
| `PUT settings/<block>` with `{"value": …, "revision": n}` | 保存一个块：`saved`、该块的新 `revision`、`policy_changed` 和 `restarting`。`value` 是 `GET settings` 所持有的整个块；缺失的键使用默认值 |
| `POST executor/pause` with `{"paused": true}` or `false` | 暂停或恢复处理：`paused` |
| `POST setup/check` | 通过重启 dsh-superagent 再次运行设置检查：`restarting: true`。当设置中没有需要修复的内容时会拒绝执行 |
| `POST policy-sync/<source id>` | 立即同步该 Source 的允许列表：`policy`，以及保存后的 Source 部分 |
| `GET prompts`, `PUT prompts` with `{"config", "baseRevision"}` | 读取提示词配置：`current`，包含其 `revision` 和 `config`；`defaults`；`sections`；团队段落，按 Session 读取它们的顺序排列；`skillName`；团队 skill 的名称模式；`builtin`，即团队 skill 不得使用的名称；以及 `skillPrefix`，即 Session 加载 skill 名称时使用的前缀。或者保存配置：返回新的 `revision` |
| `POST tickets/<id>/retry`, `POST tickets/<id>/stop` | 与面板相同，重试或停止一个 Ticket |

健康状态条目按职责分组：

| 条目 | 报告内容 |
| --- | --- |
| `runtime` | 应用本身 |
| `models` | 正在等待模型预算重试的 Session |
| `evals` | 最近一小时内不可用，并且之后没有判定或驳回的 Eval |
| `assessment`, `launch`, `delivery`, `relay`, `notice`, `reply` | [003 执行](003-execution.zh-CN.md) / [English](003-execution.md) 中描述的已存储工作；delivery 统计等待中的工作，而 reply 涵盖 Channel 消息 |
| `worker` | Executor Session 事件处理；首次失败后出现 |
| `github`, `feishu`, `history` | Source 轮询、事件和历史恢复 |
| `sync:<source id>` | 允许列表同步 |

拒绝响应会包含一个状态码和英文 `error` 文本：

- 400：无效值（`issues`，每项包含其 `path`）、失败的账户检查（`setup`）、固定类型的拒绝（`code` 和 `values`），或请求体不是 JSON 或体积过大。
- 404：目标不存在。
- 409：revision 过期。
- 500：其他所有情况。

各配置块如下：

- `source:github`、`source:feishu`：`{"enabled": true, "config": {…}}`。GitHub 配置包含 `repository` 和 `cli`，以及开关 `observeIssues`、`observePulls`、`observeComments` 和 `observeCi`；这些开关默认关闭，启用后会接收仓库中的每个新 Issue、新拉取请求和评论，以及默认分支的 CI。飞书配置包含 `cli`、形如 `[{"chatId": "oc_…", "name": "…", "listen": "mentions"}]`（也可以是 `"all"`）的 `chats`、`directMessages`，以及取值为 `"none"` 或 `"mentions"` 的 `otherChats`。
- `policy`：`{"rules": […], "sources": {"github": {"allowed": [{"id": "<login>"}], "bots": [{"id": "dependabot[bot]"}]}, "feishu": {"allowed": [{"id": "ou_…", "name": "…"}], "syncChat": "oc_…", "admission": {"oc_…": {"unlistedAddressed": "explicit"}}}}}`。`bots` 列出其消息可以成为推断候选项的机器人。`admission` 行以飞书的 chat id、`other` 或 `direct` 为键，以 GitHub 的 `issues`、`pulls`、`comments` 或 `ci` 为键；未设置的单元格采用其默认值（参见 [002 授权](002-authorization.zh-CN.md) / [English](002-authorization.md)）。
- `eval`：`mode`、`timeoutSeconds` 和 `model`。
- `executor`：`model`、`maxWorkers`、`directory`、`prepare` 和 `blockedCommands`。处理暂停是独立设置 `paused`，由 `POST executor/pause` 设置。

更改仓库或 CLI 时，会先运行对应的设置检查。检查失败时返回 400，并在 `setup` 中提供详情。账户更改成功，或设置仍处于待完成状态时执行任何保存，都会返回 `restarting: true`。应用重启期间，该 API 会暂时不可用。

```sh
api=http://127.0.0.1:3082/orchestrator/api
rev=$(curl -s -H 'x-orchestrator-request: 1' $api/settings | jq '.sources[] | select(.id == "github") | .revision')
curl -s -X PUT -H 'x-orchestrator-request: 1' -H 'content-type: application/json' $api/settings/source:github \
  -d "{\"value\": {\"enabled\": true, \"config\": {\"repository\": \"acme/widgets\", \"cli\": \"$HOME/.local/bin/gh-agent\"}}, \"revision\": $rev}"
```

## 设置检查

设置检查与工作器 shell 一样，使用 DeepSeek Harness 子进程服务。它会移除名称中包含 KEY、PASSWORD、SECRET 或 TOKEN 的环境变量。

设置检查会验证 GitHub 仓库和 Agent 的推送权限，写入工作器环境，并检查 git 是否仅对 github.com 使用 Agent 的凭据。飞书设置失败只会禁用飞书 Source。关闭 GitHub Source 会一并去掉账号检查：设置检查只保留仓库名、跳过 CLI 身份验证，因此 `gh` 未登录或网络不通时，不再拖停不使用 GitHub 的那些 Source。

设置检查写入的进程环境如下：

- **命令 shim** 位于 `<stateDir>/worker-bin`，并排在 `PATH` 首位：`gh` 运行 Agent 的 CLI；`lark-cli` 运行机器人的 CLI；被阻止的命令会失败。shim 在运行其目标程序前，会从 `PATH` 中移除自己的目录。
- **git 配置**位于 `<stateDir>/worker-gitconfig`：它会替换操作员的全局和系统 git 配置。它将 Agent CLI 选为 github.com 的 credential helper，将 GitHub SSH 地址重写为 HTTPS，并定义 Git LFS filter。个人 git 设置（例如 HTTP 代理）不会生效。这里不会设置提交身份，git 永远不会提示输入凭据，并且会移除 `GH_TOKEN` 和 `GITHUB_TOKEN`。

如果 `worker-bin` 或 `worker-gitconfig` 中存在不是由 dsh-superagent 写入的文件，设置会停止。如果某个 Ticket 目录位于一个 git 仓库内，而该仓库自身的配置添加了凭据，则该 Ticket 会失败。

## 试运行

使用允许列表中的 GitHub 账户，创建一个包含 `@<agent login> <request>` 的 Issue，或发布一条包含该内容的评论。在一个轮询间隔内（默认为一分钟），Overview 应显示一个 Ticket。Agent 会确认请求，在自己的 Session 和目录中工作，并在原始会话中交付结果。使用飞书时，请在已配置的聊天中提及机器人。

## 升级

1. 等待所有 Executor 都不处于一轮执行的中途。
2. 备份 `<stateDir>/orchestrator.sqlite`。
3. 运行 `git pull && pnpm install && pnpm build`。
4. 运行 `scripts/dsh-superagent restart` 并检查其状态。

重启会终止正在运行的 Assignment，并使用恢复说明启动替代项。团队文本和已覆盖的提示词部分会保留；没有覆盖的部分会跟随新的默认值。升级后，请检查标记为 **Default updated** 的部分。

由较新版本迁移过的数据库无法由旧版本打开。因此，回滚需要使用升级前的备份。升级 DeepSeek Harness 本身后，请重启正在运行的实例，使面板加载与之匹配的 artifacts。

### Agent preset（智能体预设）

worker 和 router preset 会在 5 秒后将 shell 命令移至后台。缺少 preset 时，Session 无法加载。在它们的 Session 仍被使用期间，请保留 `cordis.patch.yml` 中的 `dsh-superagent-worker` 和 `dsh-superagent-router` 行；否则恢复会失败，并报 `agent-preset/not-found`。

## 故障排查

设置问题会显示在 Overview 上，并带有指向修复位置的链接，其语言与面板一致；日志和 API 会显示下表中的英文文本。

| 症状 | 原因与修复方法 |
| --- | --- |
| `The agent GitHub CLI is not set.` | 在 GitHub 卡片上设置 Agent 的 CLI |
| `The agent GitHub CLI was not found.` | 设置包装脚本的绝对路径，或设置 `PATH` 中的命令名 |
| `The agent GitHub CLI cannot read its account` | 使用 `auth login` 登录包装脚本 |
| `@… cannot read …` or `@… cannot push to …` | 授予 Agent 账户对仓库的写权限 |
| `The GitHub Source names no repository.` | 在 GitHub 卡片上设置仓库，即 `owner/name` |
| Ticket 失败并显示 `The prepare command failed: …` | 输出会指出原因，例如 clone 路径错误；修复命令，然后重试该 Ticket |
| `git does not read the github.com credential configuration dsh-superagent writes` | 安装 git 2.32 或更高版本 |
| Ticket 失败并显示 `The git configuration of the repository in … sets …` | 从 clone 的 `.git/config` 中移除指定的 credential 或 `http.*.extraheader` 设置 |
| `… was not written by dsh-superagent` | 将指定文件移出 `<stateDir>/worker-bin` 或 `<stateDir>/worker-gitconfig`，或者选择其他 `stateDir` |
| `The bot lark-cli allows user identities` | 按上文飞书机器人一节所示，将飞书 Source 指向仅允许机器人身份的配置 |
| `The bot lark-cli does not work.` or `The bot identity of app … is …` | 检查配置的 app id 和密钥 |
| `The Feishu bot is not a member of the chat.` | 在聊天设置中将机器人加入聊天；下一次尝试会成功 |
| `status` 以退出码 2 退出 | 某个部分报告了错误，而重启无法修复：`errors` 会按管理 API 下的列表给出每个部分及其详情；每个部分恢复工作后会清除自己的条目 |
| `status` 以退出码 3 退出 | 设置正在等待：`setup` 会说明缺少什么，Overview 会链接到可修复问题的设置 |
| `status` 以退出码 1 退出 | 服务未运行、运行了两个实例、没有响应，或其运行时报告错误；输出和最新日志会说明具体情况 |
| `… timed out after 90 s`, `… was stopped by …`, `… exited with code …` or `… could not run: …` | CLI 失败但没有输出原因；以操作员用户身份手动运行指定程序，查看它自身的消息 |
| 面板提示 dsh-superagent 没有响应 | 服务正在重启，或由于配置问题未能启动；DeepSeek Harness 日志会指出原因 |
| `dsh-superagent configuration has keys it does not use`（日志） | 移除指定的键；消息会说明每个值现在位于何处 |
| 日志显示该插件与当前运行的 dsh 不兼容 | 安装处于 `engines.dsh` 范围内的 DeepSeek Harness 版本 |
| DeepSeek Harness 升级后，面板显示 "Failed to load plugins" | 重启正在运行的实例 |
| 提及后没有任何反应 | 检查作者是否在 Source 的允许列表中、Source 是否已开启，以及处理是否未暂停。在 GitHub 上，通过编辑 Issue 正文新增的提及不会被接收；请在评论中提及 Agent |
