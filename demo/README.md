# SuperAgent 本地实战演示

这是一个可重复、无需账号与网络的浏览器演示。它用本地服务展示 SuperAgent 的治理生命周期，并在隔离的 Git 仓库里真实执行测试、改代码、提交和生成 patch。

> 本仓库是**研究原型，非 production 软件**。本演示证明的是一条本地、确定性的实战链路，不证明现有原型已经适合生产部署。项目声明见[根 README](../README.md)，正式操作背景见[执行说明](../docs/003-execution.md)与[部署手册](../docs/006-deployment.md)。

## 30 秒启动

前提只有 Git 和受支持的 Node.js：Node.js `^22.19.0` 或 `>=24.0.0`。演示不需要 pnpm、npm 安装、GitHub 登录、DSH 或网络。

```sh
demo/verify.sh
demo/start.sh
```

看到 `SuperAgent demo URL` 后，在浏览器打开：

<http://127.0.0.1:4173>

页面顶部始终标明“本地实战模式”。终端保持运行；演示结束按 `Ctrl+C`。如果 4173 已被占用，使用 `DEMO_PORT=4180 demo/start.sh`。

## 7 分钟演示脚本

整个 guided flow 只需按主按钮七次。每一步先读按钮旁的说明，再观察页面中的 phase、生命周期、Ticket、时间线与 patch。

1. **初始化本地实战仓库（约 30 秒）**：点击“初始化本地实战仓库”。看点是 `demo/.runtime/repo` 出现，`main` 上产生基线 commit，但还没有 Ticket。
2. **Issue → Eval → Ticket（约 45 秒）**：保留默认请求或修改 Issue 文本，点击“接收 Issue → 生成 Ticket”。看点是显式请求经过 Trigger、Eval、Decision、Mandate，形成一个 durable Ticket；worker slot 仍为 `0 / 1`。
3. **第一次 RED → GREEN（约 90 秒）**：点击“运行 Worker：RED → GREEN”。看点是 worker 先新增 100% 折扣回归测试并记录 RED，再修实现、跑全量 fixture tests、写第一个真实 commit；页面显示真实 patch 与测试证据。
4. **PR Review 跟进（约 45 秒）**：点击“注入 PR Review 跟进”。看点是模拟的 PR thread 订阅把反馈交回原 Ticket；Ticket、Session 与 branch 身份不变。
5. **第二次 assignment（约 90 秒）**：点击“运行跟进 Worker”。看点是同一分支加入非有限数校验、测试和说明，产生第二个真实 commit；worker 上限始终是一。
6. **恢复（约 45 秒）**：点击“模拟重启 → 恢复状态”。看点是服务从持久化 state 与 Git history 恢复，只新增 recovery event，不重复 Ticket、assignment 或 commit。
7. **人工合并终态（约 30 秒）**：点击“合并并结束 Ticket”。看点是本地 review 被标记通过，Ticket 进入 `ENDED / MERGED`；这里没有向 GitHub push 或真正合并远端 PR。

剩余时间可刷新浏览器，确认同一 state 仍在；再打开 live-mode doctor，解释当前机器到真实部署还缺什么。

## 命令与环境变量

| 用途 | 命令或变量 | 说明 |
| --- | --- | --- |
| 验收 | `demo/verify.sh` | 可从任意 cwd 运行；检查 Node/Git、fixture、全部 demo tests、JS 语法和 `git diff --check` |
| 启动 | `demo/start.sh` | 可从任意 cwd 运行；只监听 `127.0.0.1` |
| 端口 | `DEMO_PORT=4180 demo/start.sh` | 默认 `4173`；只接受 `1..65535` 的十进制整数 |
| runtime | `DEMO_RUNTIME_DIR=/absolute/demo-runtime demo/start.sh` | 默认是仓库内 `demo/.runtime`；相对路径以仓库根目录为基准；空白值被拒绝 |

`start.sh` 不读取 `.env`，不 `source` 用户文件，也不继承 token、代理或其他任意环境变量。它只把 `PATH`、校验后的 `DEMO_PORT` 与明确的 `DEMO_RUNTIME_DIR` 交给 Node 服务。

## 生成的真实产物

默认运行后会出现以下本地文件；自定义 `DEMO_RUNTIME_DIR` 时，把前缀 `demo/.runtime` 换成指定目录。

| 产物 | 默认位置或值 | 内容 |
| --- | --- | --- |
| durable state | `demo/.runtime/state.json` | versioned JSON；保存 Ticket、Assignment、Report、timeline、branch 与 commit 证据 |
| 隔离仓库 | `demo/.runtime/repo` | 从 `demo/fixture` 复制并初始化的真实 Git repository |
| 工作分支 | `agent/demo-discount-boundary` | 两次 assignment 始终使用同一分支 |
| 基线 commit | `chore: initialize discount fixture` | reset/初始化时在 `main` 创建 |
| 第一个 worker commit | `fix: support 100 percent discounts` | 回归测试先 RED，修复后 GREEN |
| 第二个 worker commit | `fix: reject non-finite discount inputs` | 同一 Ticket 的 review 跟进 |
| PR-style patch | API state、页面 patch 面板及 `git diff main..agent/demo-discount-boundary` | 从基线到当前分支的真实 diff；没有远端 PR |

可只读核对：

```sh
git -C demo/.runtime/repo status --short
git -C demo/.runtime/repo log --oneline --decorate --all
git -C demo/.runtime/repo diff main..agent/demo-discount-boundary
node --test demo/.runtime/repo/test/*.test.mjs
```

## 真实与模拟的边界

**本地真实发生：** 创建文件和 Git repository；创建 branch；先写失败测试；修改 fixture 源码；运行 Node test；创建两个 commit；生成 patch；原子保存 JSON state；从 state 与 Git history 恢复。

**为了稳定演示而模拟：** GitHub Issue/mention、Eval 的模型判断、GitHub notification/PR/review thread、DSH Session/worker 调度、远端 push、CI、审批与 merge。生命周期 reducer 和 deterministic worker 表达这些概念，但不是 production DSH runtime。

因此，页面上的 “merged” 只是本地 Ticket 终态；它不会调用 `gh`、不会改外部仓库，也不会声称完成了 GitHub merge。要理解原型实际授权与订阅规则，请读[授权说明](../docs/002-authorization.md)；要理解生产 worker 与恢复，请读[执行说明](../docs/003-execution.md)。

## 架构与数据流

```text
浏览器控制室
  │ loopback JSON API
  ▼
Node 本地服务
  ├─ immutable lifecycle reducer
  ├─ atomic JSON store ───────────────> demo/.runtime/state.json
  ├─ deterministic Git worker ───────> demo/.runtime/repo
  │                                    branch → RED → edit → GREEN → commit → patch
  └─ read-only live doctor ──────────> node/git/gh/gh-auth/dsh/source checks
```

服务只绑定 loopback，状态变更只接受 POST JSON。服务端限制 request body、校验 Host/Origin，并把 runtime、public 与 fixture 强制分成不同目录树。更完整的生产组件关系见[架构文档](../docs/007-architecture.md)。

## API 与 curl

以下命令都只访问本机。换端口时先修改 `base`。

```sh
base=http://127.0.0.1:4173

curl -sS "$base/api/state"
curl -sS "$base/api/doctor"
curl -sS -X POST -H 'content-type: application/json' -d '{}' "$base/api/reset"
curl -sS -X POST -H 'content-type: application/json' \
  -d '{"title":"Allow a complete discount","requester":"demo-user","text":"A 100 percent discount must return zero."}' \
  "$base/api/issue"
curl -sS -X POST -H 'content-type: application/json' -d '{}' "$base/api/run"
curl -sS -X POST -H 'content-type: application/json' \
  -d '{"requester":"demo-reviewer","text":"Reject non-finite inputs."}' \
  "$base/api/follow-up"
curl -sS -X POST -H 'content-type: application/json' -d '{}' "$base/api/run"
curl -sS -X POST -H 'content-type: application/json' -d '{}' "$base/api/recover"
curl -sS -X POST -H 'content-type: application/json' -d '{}' "$base/api/merge"
```

每个 mutating route 都要求 `Content-Type: application/json`。无效顺序返回 409；未知 API 返回 JSON 404；服务不会向响应暴露 stack 或环境值。

## 停止、重置与清理

- **停止服务：** 在运行 `demo/start.sh` 的终端按 `Ctrl+C`。脚本使用 `exec`，信号直接到 Node 服务。
- **重置演示：** 使用页面的“重置演示”按钮，或 POST `/api/reset`。重置只重建所选 runtime 之下的 `repo/` 和 state；不要把 runtime 指向重要目录。
- **保留证据：** 停止服务不会删除 state 或 repository。重新启动会继续读取它们。
- **清理默认 runtime：** 先停止服务，确认路径，再执行下面的防误删检查。它只针对仓库内精确的 `demo/.runtime`，不适用于自定义 runtime。

```sh
repo=$(git rev-parse --show-toplevel) || exit 1
runtime=$repo/demo/.runtime
[ "$runtime" = "$repo/demo/.runtime" ] || exit 1
printf '将删除且仅删除：%s\n' "$runtime"
[ -d "$runtime" ] && rm -r -- "$runtime"
```

不要对空变量、`~`、仓库根目录或通配符运行递归删除。自定义 runtime 应先打印绝对路径、确认其中只有本演示产物，再由操作员明确删除；启动和验收脚本不会替你清理它。

## 故障排查

| 现象 | 原因与处理 |
| --- | --- |
| `Node.js ^22.19.0 or >=24.0.0 is required` | 切换到受支持的稳定版 Node；Node 23 不在范围内 |
| `git is required on PATH` | 安装 Git 并确认 `git --version` 可运行 |
| `DEMO_PORT` 错误 | 值必须是非空十进制整数 `1..65535`；端口被占用时换一个端口 |
| `DEMO_RUNTIME_DIR` 错误 | 不得为空白；使用一个专门目录，不能与 `demo/public` 或 `demo/fixture` 重叠 |
| 浏览器无法连接 | 保持启动终端运行；打开终端打印的 `127.0.0.1` URL，不要改成公网地址 |
| API 返回 `RUNTIME_INTEGRITY_ERROR` | runtime 路径、inode 或链接在运行中改变；停止服务，检查目录后重启 |
| API 返回 `WORKER_NOT_READY` | runtime repo 与 state 不一致；保存需要的证据后，用 reset 重建本地 lab |
| assignment 失败 | 页面保留失败 Report；查看终端与页面错误，确认 runtime 可写、Git 可用，再 reset 重试 |
| doctor 显示 blocked | 不影响本地演示；它只描述真实 GitHub/DSH 模式的前提 |

在当前开发机上，live-mode doctor 预期至少显示 `dsh` 与 `gh-auth` blockers：DSH 未就绪、GitHub CLI 未以专用账号认证。环境改变后结果也会改变；doctor 只读，不修复或登录。

## 安全边界

- HTTP 只监听 `127.0.0.1`；server 自身再次拒绝非 loopback bind、异常 Host 与跨站 Origin。
- `start.sh` 对 port/runtime 做边界校验，以最小环境启动；不 `eval`，不 source 用户文件，不执行清理。
- worker 只写明确 runtime 下的隔离 `repo/`，用参数数组调用 Git/Node，不拼接 shell 命令；runtime、fixture 与 public 不能重叠。
- Git 使用 repository-local demo identity、隔离配置、禁用 hooks 和凭据提示；本地演示不读取或保存 token。
- reset 有路径和 inode 防护，但自定义 runtime 仍是操作员授权的写入范围。只给它一个专用空目录。
- 本地 worker 是确定性教学实现，不是安全沙箱。production 原型的 worker 具有操作系统用户权限；真实部署必须使用专用 OS 账号。详见[部署权限边界](../docs/006-deployment.md#permissions-and-isolation)。

## 验收

自动验收：

```sh
demo/verify.sh
```

完成后应看到 fixture test file 数、全部 `demo/tests/*.test.mjs` file 数、syntax file 数、Git whitespace check，以及 `Verification complete`。脚本运行 `git diff --check`，但**不会**要求整个工作树 clean，也不运行 pnpm/npm 或访问网络。

人工验收清单：

- 从仓库外 cwd 运行 `demo/start.sh`，打印的 URL 可访问，runtime 仍落在明确目录。
- 七步完成后只有一个 Ticket、一个 Session、一个 branch、两个 worker commits，tests 为 green。
- 刷新和 recover 后 Ticket/branch/commits 不变，timeline 多一个 recovery event。
- patch 与 runtime repo 的 `git diff main..agent/demo-discount-boundary` 一致。
- 页面明确标注本地真实与 production 替换边界；doctor blockers 不被误报成本地演示失败。

## 升级到真实 GitHub / DSH

只有在接受[研究原型声明](../README.md)、读完[部署手册](../docs/006-deployment.md)并完成[SETUP 引导](../SETUP.md)后，才进入 live 模式。建议第一次演练使用一个无秘密、可丢弃、**GitHub-only** 的 sandbox；不启用 Feishu。

可选 sandbox 是 `unjs/defu` 在固定 upstream SHA `82632b66f5914e9946edce300e10633a3d5c0cb7` 的专用 fork。固定 SHA 只是让测试基线可复现，不代表该第三方仓库获得本项目背书。本手册和 demo 脚本**不会自动 clone 或 push**；操作员必须核对 owner、remote、commit、branch protection 与写权限后，亲自创建 fork/clone 并授权。

严格按以下顺序升级，任何一步未通过都不要继续：

1. **隔离身份。** 创建专用 OS account；创建专用 GitHub account，只授予 sandbox fork 的最小 write 权限。不要复用个人 home、SSH key 或 GitHub 登录。
2. **准备工具。** 在专用 OS account 下安装文档要求的 Node、pnpm、Git、Python、tmux、`gh >=2.48` 与符合 `package.json#engines.dsh` 的 DSH；配置并实测一个 model provider。
3. **固定代码与目标。** 审查本原型 checkout；另行准备 sandbox fork 的 clone，确认 upstream 基线恰为上述 SHA。不要让第一个 live run 接触生产 repository。
4. **创建专用 DSH profile。** 按部署手册新建 `superagent` Web profile；不要覆盖已有 profile。为它设置专用绝对 `stateDir`，例如专用账号 home 下的 `.dsh/state/superagent`，并确保备份和权限独立。
5. **创建 `gh` wrapper。** 按[Agent GitHub account](../docs/006-deployment.md#agent-github-account)创建 `gh-agent`，用独立 `GH_CONFIG_DIR` 登录专用 GitHub account；用 `gh-agent api user --jq .login` 核对身份。Source 的 CLI 必须指向这个 wrapper，而不是个人 `gh`。
6. **构建并启动 prototype。** 按部署文档安装 bundle、复制 profile 配置、构建并启动；先看 `scripts/dsh-superagent status` 与 panel setup checks，确认 DSH/profile/provider/stateDir 都健康。
7. **只配置 GitHub Source。** repository 指向 sandbox fork，CLI 指向 `gh-agent`；保持 Feishu Source disabled。先验证 agent account 的读、push 与 notification 能力。
8. **收紧为 explicit-only。** Policy allowed list 先只放一名操作员；accept mode 设为 `off`，让 inferred candidates 不被接纳；admission table 的未列名、未提及与 bot 路径都设为 ignore。只有 allowed operator 明确 `@agent` 的请求可建 Ticket。
9. **限制执行。** 在 Settings → Deployment 把 `maxWorkers: 1`；Execution root 指向专用 state/work 区；prepare command 只从已核对的 sandbox clone 创建 Ticket worktree。blocked commands 包含个人 CLI。
10. **强制 manual merge。** Delivery requirements 删除 auto-merge 段落，不配置 merge-account CLI；由人检查 diff、tests、CI 与 branch protection 后进行 manual merge。agent 可以 push branch/open PR，但不能合并。
11. **小步验收。** 用 allowed operator 在 sandbox Issue 写一次明确 mention；确认一条 Trigger → Eval → Ticket、一个 worker、一个 PR。核对 author、remote、patch、CI 与没有额外仓库写入，再决定是否扩大 allowlist 或 accept mode。

真实部署的 source、policy、executor、prompt 保存顺序及 prepare command 示例以[部署手册](../docs/006-deployment.md)为准；不要从本地 demo 的 simulated lifecycle 反推 production 配置。
