# Any Listen 多账号部署与维护

基于上游 `80cce020912dda64dace135c81d046cd9aad5f4d`，功能分支为 `multi-user`。
账号入口、Svelte 页面和每账号后台均在本仓库。一个容器内按需启动每账号进程，不改音乐数据库为共享表。

## 部署

要求 Docker Compose、HTTPS 反向代理和持久化卷。宿主机直接运行要求 Node.js 24、pnpm 10.34.5。
所有以下命令在仓库根目录执行。生产数据不要使用测试预览目录。

```sh
docker compose -f compose.multi-user.yml build
```

首次启动会在空账号数据库中自动创建管理员。设置 `.env`：

```dotenv
PUBLIC_ORIGIN=https://music.example.com
ANYLISTEN_TAG=multi-user-local
ADMIN_USERNAME=admin
ADMIN_PASSWORD='这里换成你自己的初始密码'
```

用户名为 3 至 32 位英文字母、数字、点、下划线或连字符，首位须为字母或数字；密码为 12 至 128 个字符。`.env` 密码用单引号包围，避免 `$` 和 `#` 被解析，含单引号的密码可改用密码文件。Compose 自动创建或复用固定名称的 `any-listen-data` 卷，程序创建卷内目录。旧部署若使用项目名前缀的卷，先修改 Compose 的卷 `name` 指向原卷，避免误用空卷。

```sh
docker compose -f compose.multi-user.yml up -d
```

空数据库缺少有效初始化配置时启动失败，修正后重新部署。已有账号时跳过初始化，更改或移除环境变量不会覆盖密码。首次登录强制改密并重新登录，随后删除 `.env` 中的 `ADMIN_PASSWORD` 并重建容器。初始密码不打印到日志，但 Docker 管理员可查看容器环境变量。

1Panel 导入镜像的完整流程见 [镜像文件部署](image-import.md)。

### 可选：密码文件或手动初始化

自动初始化也支持 `ADMIN_USERNAME` 和 `ADMIN_PASSWORD_FILE`：在 Compose 挂载密码文件，设置容器内路径，并移除 `ADMIN_PASSWORD`。密码文件须让容器用户 UID 1000 可读。不能同时提供非空的 `ADMIN_PASSWORD` 和 `ADMIN_PASSWORD_FILE`。

需要迁移旧数据或手动创建管理员时，仍可在服务停止状态下初始化。将初始密码放在仅管理员可读且容器用户可读取的本地文件 `admin-password.txt`，然后执行：

```sh
docker compose -f compose.multi-user.yml run --rm --no-deps \
  -v "$PWD/admin-password.txt:/run/admin-password:ro" \
  -e ADMIN_PASSWORD_FILE=/run/admin-password \
  any-listen create-admin admin
```

密码不进入命令参数、镜像或日志；初始化后移除密码文件。首次登录强制改密并重新登录。
网站不提供公开注册。管理员在账号页面创建用户、重置密码、禁用或恢复账号。
首次管理员已经存在时初始化命令拒绝执行；其他管理员通过账号管理创建。

Compose 默认仅绑定宿主机 `127.0.0.1:9500`，不设置容器内存上限，实际可用内存取决于宿主机和 Docker 运行环境。`PUBLIC_ORIGIN` 必须与浏览器地址的协议、主机和端口完全一致，不带尾部 `/`。
HTTPS 时会话 Cookie 自动设置 Secure。直连本地测试可用 `http://localhost:9500`。
反向代理必须支持 WebSocket、Range、关闭响应缓冲，并允许发布操作等待数分钟：

```nginx
location / {
    proxy_pass http://127.0.0.1:9500;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_buffering off;
    proxy_read_timeout 600s;
    client_max_body_size 16m;
}
```

入口不信任外部 `X-Forwarded-*`，限速使用 TCP 来源地址；经过反代时所有用户会共享代理 IP 的额度（15 分钟 50 次），账号额度为 10 次。反代可另加真实客户端限速。会话默认 30 天，服务端只保存令牌摘要。

## 数据布局

```text
/data/accounts.sqlite                 账号、会话、审计、发布及迁移状态
/data/users/<UUID>/app/               上游数据库、设置、deviceid、扩展
/data/users/<UUID>/cache/             私有缓存
/data/users/<UUID>/temp/              私有临时文件
/data/users/<UUID>/imports/           管理员可见导入目录
/data/publications/<UUID>/            不可变音源发布版本
/data/legacy-backups/<admin UUID>/     旧数据原始备份
/data/migration/<admin UUID>/         迁移暂存及失败记录
```

用户名修改不影响目录（当前版本不提供改名）。不支持永久删除账号。用户角色创建后固定。
个人歌单、收藏、历史、队列、设置和缓存均独立，同账号多设备按上游行为同步。
账号页面的个人备份只包含歌单，限制 16 MiB，恢复会替换全部歌单；不接受服务器路径、脚本或本地文件列表。
完整管理员数据和含本地歌曲的备份由运维备份整个卷。普通用户不能管理扩展、执行扩展命令、导出配置和日志或操作服务器文件。
上游新增 RPC 默认拒绝普通用户，合并时须明确审查后加入允许列表。

没有账号数或活跃进程上限。无连接、无流和无任务默认 5 分钟后回收；关闭浏览器标签页才会释放 WebSocket 活跃计数。
`ACCOUNT_IDLE_MS` 可修改空闲时间。后台停止期间不执行同步。异常进程按请求触发退避重启，连续失败累计到 5 次后需管理员在运行状态中重试，或重新发布。
运行状态展示每账号 RSS；后台使用 worker threads，RSS 为整个账号进程指标。总内存还需加入口及容器开销。
进程分隔用于状态隔离，可信管理员安装的扩展仍不是安全沙箱。

托管模式的公共 HTTP 请求库在建立连接时检查目标 IP，默认拒绝回环、内网、链路本地及保留地址；重定向也重复检查。出站代理被禁用，以免绕过地址校验。内网 WebDAV 或音源需要运维在入口进程配置 `ANYLISTEN_ALLOWED_MEDIA_ORIGINS`，值为精确 origin 的 JSON 数组，例如 `["http://192.168.1.10:8080"]`。放行意味着所有账号都能通过媒体代理访问该 origin，不能包含管理后台、数据库或云元数据地址。此限制仅覆盖公共请求库，不约束可执行任意 Node.js 代码的管理员扩展。

## 管理员音源发布

管理员进入播放器的扩展管理，安装、升级和配置：

- `online-metadata`：搜索、封面、歌词等。
- `lx-api-source-loader`：导入管理员提供的 LX 脚本，再勾选启用。仅安装加载器不等于有可用音源。

本地脚本可通过上游文件对话框导入，也可使用加载器的远程脚本入口。若对话框显示服务器目录，将文件放入该管理员 `imports/` 后选择。
管理员数据是可编辑草稿，普通用户只收到发布版本。多管理员各自有草稿，由执行发布的管理员提供本次版本；建议固定一个管理员维护音源。
返回账号管理，点击“发布配置”。流程为停止草稿进程、收集两个扩展的包和配置、复制加载器实际脚本，在一次性用户进程内验证初始化，再逐一切换活跃普通用户。
配置引用、重复脚本 ID、缺失脚本、未启用脚本、加载失败都拒绝发布。LX 初始化通过当前加载器的成功日志标记验证，升级加载器后须重跑验收。
任一用户失败时回滚已切换用户，显示失败账号及回滚失败项；可重试发布。入口重启后会以账号数据库中最后成功版本修复未完成的应用操作。
首次发布失败时账号及歌单仍可使用，音源保持未发布。其他扩展和管理员私有数据不分发。
普通用户运行目录各自独立，发布仅替换受管文件，保留其他运行数据。发布目录包含脚本和可能的密钥，应按敏感备份管理。
切换会重连并重新加载页面，保留服务端队列和歌单、清空旧播放地址缓存。浏览器可能要求用户再次点击播放。

## 从旧部署迁移

1. 停止旧容器，另外保存旧镜像版本和完整旧数据备份。旧目录和新卷必须互不包含。
2. 按部署步骤创建新管理员，暂不进入播放器（进入会创建用户数据目录）。
3. 把旧数据只读挂载到迁移命令；以下 `OLD_DATA` 是包含 `app/` 的旧 DATA_PATH：

```sh
docker compose -f compose.multi-user.yml run --rm --no-deps \
  -v "$OLD_DATA:/legacy:ro" any-listen migrate admin /legacy
```

迁移复制完整原始备份，再暂存 `app/` 和缓存，运行 SQLite integrity_check，保留歌单 ID、引用、设备标识和扩展数据，最后重命名到管理员目录。
旧入口配置和旧登录令牌不导入，统一密码不能登录新站点。
检查管理员目录中的 `migration-report.json`：绝对路径逐项列出并记录迁移机器上是否存在；容器内还需检查挂载和读权限。迁移不会删除失效路径对应歌曲。
管理员本地媒体默认也限制在 `imports/`。既有本地库记录保留，但需要另行调整挂载和受信路径策略后才能继续读取。
完成标记避免重复导入；失败保留暂存目录和 `failure.json`。失败后保留备份与失败记录，在新目标卷重新创建管理员并重试；不要让旧服务读取半迁移目录。

## 升级与回退

停止服务并备份整个账号卷后再更换定制镜像标签。禁用网页内程序更新，统一用 Docker 升级。
回退多账号版本时恢复该版本对应的卷备份。回退旧单账号版本时使用旧镜像和迁移前原始备份，绝不直接把多账号卷交给旧镜像。
服务提供 `/healthz`，只表明入口存活；账号启动错误须在管理员运行状态中检查。

## 开发、测试及上游合并

```sh
SKIP_LIB_COPY=1 ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install --frozen-lockfile
pnpm -F @shared/eslint exec tsc -p ../../web-server/tsconfig.accounts.json
pnpm build:web
node packages/web-server/tests/run.cjs
pnpm -F @shared/scripts build:desktop
```

上游 Web/桌面构建都会清理 `build/`，测试 Web 必须放在 Web 构建之后，且重建时先停止本地预览以释放 Windows 原生模块文件锁。
全量前端检查命令为 `pnpm -F view-main exec svelte-check --config ./svelte.config.js`；当前基线存在已有类型错误，详见验收记录。
必须使用仓库指定的 pnpm 10.34.5；其他主版本可能重新解析锁文件。系统版本不匹配时可用 `npm exec --yes --package=pnpm@10.34.5 -- pnpm <命令>`。
官方扩展兼容测试先解包指定版本 `.alix`，再解包其中 `ext.tgz`，放入 `work/extension-packages/loader` 和 `metadata`。执行 `ACCOUNT_EXTENSION_PACKAGES="$PWD/work/extension-packages" node packages/web-server/tests/run.cjs extensions.test.ts`。CI 固定版本与 SHA256，升级扩展时同步更新。
本地试用：Web 构建后运行 `node packages/web-server/tests/preview.cjs`，仅监听本机 9510，使用独立 `work/preview-data`。测试账号 `preview-admin`、`preview-user`，密码 `Preview-local-12345`。禁止用于生产。

```sh
git remote add upstream https://github.com/lyswhut/any-listen.git
git fetch upstream
git switch main
git merge --ff-only upstream/main
git switch multi-user
git merge main
```

合并后审查 RPC 允许列表、初始化顺序、资源 URL 前缀、扩展目录及配置结构，运行账号隔离、发布、迁移、Web 与桌面构建检查，再使用真实脚本验收并备份升级。
`main` 只同步上游。自定义工作流在 `xiao-baii/any-listen` 的 `multi-user-v*` 标签或手动运行 `multi-user` 分支通过检查后，导出 Linux AMD64 Docker TAR 至 Actions Artifacts，保留 30 天，不再推送 GHCR。镜像标签为 `any-listen:<标签或分支>` 和 `any-listen:sha-<完整提交>`。
上游 release 工作流限于原仓库执行。1Panel 文件导入部署使用 `compose.image.yml`，详见 [镜像导入说明](image-import.md)；本文前面的 `compose.multi-user.yml` 仍用于源码本地构建。

## 发布前外部验收

- 使用真实的两个扩展和管理员 LX 脚本验证搜索、歌词、封面、解析、持续播放和发布重连。
- 在实际 2 GB Linux 容器中分别保持 1、3、5 个用户活跃并连续播放，记录 `docker stats` 总内存、账号 startupMs、OOM、启动及音源错误。不能用无扩展的 Windows RSS 推算 20 人容量。
- 以实际旧数据演练迁移和回退，检查所有绝对路径。
- 验证反向代理 HTTPS、Cookie Secure、WebSocket、Range、取消流及长时间发布请求。

这些外部条件未在本机得到验证，不能据当前自动化测试宣称已完成生产验收。

## 本地验收记录（2026-09-12）

- Windows x64、Node.js 26.2.0、pnpm 10.34.5；生产 Docker 指定 Node.js 24。当前机器未安装 Docker，因此未构建或运行 Linux 容器。
- 账号测试最近一次为 10 项通过，新增出站私有 IP、DNS 和重定向拦截测试；原有签名、限速、账号状态、启动合并、空闲回收、双账号隔离、同账号同步、Range、取消流、即时撤销、迁移与发布回滚测试通过。账号创建和密码写入在异步计算结束后再次校验会话。
- 官方 Online Metadata 0.4.4 和 LX API Source Loader 0.1.7：真实扩展宿主加载、可控 LX 脚本初始化、音源解析、缓存代理、认证音频读取、再次发布通过。另有受控扩展的搜索测试；没有把公网搜索或真实音乐播放标记为已验收。
- Web、桌面源码构建通过。全量 Svelte 检查为 171 errors / 19 warnings，未改动的上游基线同为 171 / 19；新增账号和移动端组件未增加诊断。
- 浏览器检查覆盖管理员和普通用户登录、退出、账号页面及播放器；桌面 1366×900，手机 390×844 和 320×740。托管模式采用全窗口布局，手机使用可收起导航和紧凑播放栏。
- 未执行：2 GB Linux 容器 1/3/5 活跃账号持续播放压测、管理员实际 LX 脚本、实际旧数据迁移回退、生产 HTTPS 代理、GHCR 构建和推送。部署前需完成这些外部验收。
