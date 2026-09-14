# 单进程多账号开发与交付

`multi-user` 分支将管理员和普通账号放在同一个 Node 进程中，共享数据库及公共音源 Worker。个人歌单、播放器、设置、代理和连接仍按账号隔离。本文记录当前实现入口、验证方法和源码交付范围。

## 文档导航

| 文档 | 用途 |
| --- | --- |
| [部署与维护](multi-user.md) | 新部署、账号管理、音源发布、升级和恢复 |
| [镜像文件部署](image-import.md) | GitHub Actions 产物与 1Panel 导入 |
| [改造方案](single-process-multi-user-plan.md) | 设计约束及阶段 0–6 的状态 |
| [ADR 0001](adr/0001-shared-online-runtime.md) | 共享进程、公共音源、串行发布的取舍 |
| [领域术语](../CONTEXT.md) | 账号、会话、草稿和公共音源的定义 |
| [内存验证](single-process-memory-results.md) | 空账号前后对照、测量口径及复现 |

核心实现和本机回归已完成；生产容器、真实管理员脚本、持续播放与发布峰值仍待验收。测试中保留旧迁移命令的回归，不代表新模式支持旧本地库或 WebDAV 数据迁移。

## 代码导航

以下路径相对于仓库根目录。

| 责任 | 主要文件或目录 |
| --- | --- |
| 入口认证、HTTP/WebSocket 路由、维护状态 | `packages/web-server/src/accounts/gateway.ts`、`lifecycle.ts` |
| 账号启动合并、失败退避、空闲回收、共享 Worker 所有权 | `packages/web-server/src/accounts/runtime.ts` |
| 账号服务组合、权限绑定、事件订阅及关闭排空 | `packages/web-server/src/accounts/context.ts` |
| 个人配置文件实例及同名文件隔离 | `packages/web-server/src/accounts/stores.ts` |
| 共享音乐数据库线程及账号通道 | `packages/web-server/src/accounts/sharedDatabase.ts`、`database.worker.ts` |
| DB 连接、预编译语句及缓存归属 | `packages/shared/app/modules/worker/dbService/context.ts`、`service.ts` |
| 公共音源执行、队列、能力限制和版本替换 | `packages/web-server/src/accounts/sharedExtensions.ts` |
| 将共享音源结果转换为账号所属资源地址 | `packages/web-server/src/accounts/extensionClient.ts` |
| 管理员文件草稿、按需编辑 Worker | `packages/web-server/src/accounts/draftExtensions.ts` |
| 发布快照、验证、维护重载、失败回滚 | `packages/web-server/src/accounts/publications.ts` |
| 歌单、播放器、不喜欢列表、资源实例 | `packages/shared/app/modules/{musicList,player,dislikeList,resources}/service.ts` |
| 在线歌单同步、账号代理流及取消 | `packages/shared/app/modules/musicList/onlineSync.ts`、`proxyServer/` |
| 账号连接集合、广播、心跳、会话撤销 | `packages/web-server/src/modules/ipc/socketService.ts` |
| 账号管理、音源上传及共享进程状态 | `packages/view-main/src/accounts/AccountPage.svelte` |
| 维护关闭后暂停播放并重载 | `packages/web-server/src/preload/ws.ts`、`auth.ts`，`packages/view-main/src/main.ts` |

`accounts/database.ts` 保存账号、会话和发布元数据；共享 DB Worker 服务的是各账号的音乐 SQLite 文件，两者职责不同。

账号上下文仍各自监听一个 `127.0.0.1` 临时 HTTP 端口，由入口使用签名身份转发，复用现有 HTTP/WebSocket 协议。这些监听器位于同一进程，不是账号子进程；端口、连接及个人状态仍随活跃账号数量增长。

共享 DB 的异步上下文用于定位账号所属连接和缓存，不通过修改进程环境变量切换用户。公共音源不接收个人歌单、播放器和私人登录凭据；管理员统一密钥可作为公共配置。共享模块保留默认入口供桌面和原单用户模式使用。

## 资源与生命周期

| 对象 | 当前限制与释放方式 |
| --- | --- |
| 账号上下文 | 无连接、流或任务默认 5 分钟回收；`ACCOUNT_IDLE_MS` 可调整 |
| 账号请求 / 音源调用 | 每账号最多 128 / 16 个在途调用 |
| 音乐 DB Worker | 全站 1 个，账号独立通道；每通道 128、全站 1024 个排队任务 |
| 歌单缓存 | 每账号 8 列表 / 2000 首，全站 64 列表 / 16000 首，超额淘汰后回查数据库 |
| 公共音源执行 | 发布后最多 1 个 Worker；调用串行执行，队列上限 128 |
| 管理员草稿编辑 | 最多 1 个文件编辑 Worker，空闲 15 秒释放，不运行音源脚本 |
| 发布及故障恢复 | 先停旧执行实例再加载候选；失败恢复上次成功版本；异常自动恢复最多 3 次 |

关闭账号先停止接收新任务，取消所属资源请求，排空已接收的持久化写入，再释放连接和 DB 通道。发布时允许中断播放，通过 WebSocket 1012 触发客户端暂停和维护结束后重载。

共享进程 RSS 包含全部 Worker，不能重复累加。上述限制不覆盖全部堆、SQLite、播放队列或并发媒体开销，也不是进程内存硬上限。

## 开发与验证

生产 Docker 使用 Node.js 24；仓库锁定 pnpm 10.34.5。命令从根目录执行。系统 pnpm 版本不匹配时，用 `npm exec --yes --package=pnpm@10.34.5 -- pnpm <参数>` 替代 `pnpm <参数>`。

```sh
SKIP_LIB_COPY=1 ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install --frozen-lockfile
pnpm -F @shared/eslint exec tsc -p ../../web-server/tsconfig.accounts.json
pnpm build:web
node packages/web-server/tests/run.cjs
node packages/web-server/tests/run.cjs database.test.ts
node packages/web-server/tests/run.cjs player.test.ts
node packages/web-server/tests/run.cjs musicList.test.ts
node packages/web-server/tests/run.cjs sharedSources.test.ts
ACCOUNT_EXTENSION_PACKAGES="$PWD/work/extension-packages" node packages/web-server/tests/run.cjs extensions.test.ts
pnpm -F @shared/scripts build:desktop
git diff --check
```

上面的环境变量写法用于 POSIX shell。PowerShell 安装前使用 `$env:SKIP_LIB_COPY='1'` 和 `$env:ELECTRON_SKIP_BINARY_DOWNLOAD='1'`；构建前用 `Remove-Item Env:SKIP_LIB_COPY -ErrorAction SilentlyContinue` 清除跳过原生模块复制的设置。官方扩展测试前使用 `$env:ACCOUNT_EXTENSION_PACKAGES="$PWD/work/extension-packages"`。

官方扩展包下载地址及 SHA256 固定在 [Multi User 工作流](../.github/workflows/multi-user.yml)。先校验 `.alix`，解包到 `work/extension-packages/loader` 和 `metadata`，再分别解包包内 `ext.tgz`。支持验证的版本为 LX API Source Loader 0.1.7 与 Online Metadata 0.4.4；测试脚本是可控样例。

测试命令必须串行运行：`run.cjs` 共用 `.generated` 目录并在结束时清理。Web 和桌面构建也共用 `build/`，不要并行执行；测试 Web 应紧跟 Web 构建。重建前停止使用该目录的预览，避免 Windows 原生模块文件锁。

本地预览：Web 构建后运行 `node packages/web-server/tests/preview.cjs`，地址 `http://localhost:9510`，数据位于独立的 `work/preview-data`。测试账号为 `preview-admin`、`preview-user`，密码均为 `Preview-local-12345`，仅供本机使用。

## 验证记录（2026-09-15）

本次文档整理在 Windows x64 / Node.js 26.2.0 上重新执行了以下检查：

| 检查 | 结果 |
| --- | --- |
| 账号集成 `accounts.test.ts` | 14 项通过 |
| 数据库 `database.test.ts` | 4 项通过 |
| 播放器与 Store `player.test.ts` | 6 项通过 |
| 歌单、资源和连接 `musicList.test.ts` | 7 项通过 |
| 公共音源 `sharedSources.test.ts` | 1 项通过 |
| 官方扩展 `extensions.test.ts` | 1 项通过，包 SHA256 与 CI 一致 |
| 账号模块 TypeScript 检查 | 通过，使用 pnpm 10.34.5 |

本轮改造此前已完成 Web 完整构建、桌面主进程构建，以及 1366×900 / 390×844 页面检查；此次文档整理未改业务逻辑，也未重新构建或进行页面验收。完整桌面安装包和桌面 UI 未重新验收。

全量前端检查命令为 `pnpm -F view-main exec svelte-check --config ./svelte.config.js`。之前记录为 171 errors / 21 warnings，未在本次重跑；包含依赖声明和既有音频代码等诊断，不能视为全量检查通过。

空账号内存测量记录为 10 账号总 RSS 从 1499.45 MiB 降至 97.21 MiB，详见[测量口径](single-process-memory-results.md)。本次未重复压测。真实脚本、公网持续播放、Linux Node.js 24 容器、生产 HTTPS 及发布峰值仍未验收；源码回归通过不等于这些部署条件通过。

## Git 提交与同步 main

本次账号入口、共享服务、前端和测试相互依赖，建议作为一个完整功能提交，附带上述文档及 CI 检查。建议提交标题：`feat: share online multi-user runtime in one process`。后续修复按独立问题提交。

上传范围包含 `.github/workflows/multi-user.yml`、相关 `packages/` 源码和测试、README、领域术语及 `docs/` 文档。`work/` 基线副本、预览数据、扩展包、日志、`build/`、测试生成文件、`.env` 和 SQLite 数据均不上传。镜像 TAR 由 CI 构建后作为 Artifact 下载，不提交到 Git。

同步上游时先提交当前改动并保持工作区干净，确认 `main` 用于跟随上游，再执行：

```sh
# 首次配置；已有 upstream 时先检查其地址。
git remote add upstream https://github.com/lyswhut/any-listen.git
git fetch upstream
git switch main
git merge --ff-only upstream/main
git switch multi-user
git merge main
```

冲突主要集中在共享模块的默认入口与实例入口、Worker API、扩展配置及 RPC 允许列表。合并时逐项检查新模块有无账号可变单例、广播是否绑定账号、在线入口是否重新启动本地/WebDAV 任务，再执行上述测试和 Web/桌面构建。不要用整文件覆盖来解决这些冲突。

推送 `multi-user` 触发检查；创建 `multi-user-v*` 标签或手动执行指定分支的工作流才会生成镜像文件。上线前完成[外部验收](multi-user.md#发布前外部验收)，升级和回退使用配套镜像与账号卷备份。
