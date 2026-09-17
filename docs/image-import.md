# 1Panel 镜像文件部署

在 GitHub Actions 的 Multi User 成功运行页底部 Artifacts 下载 `any-listen-<标签>-linux-amd64`，解压下载的 ZIP。
包内 `any-listen-linux-amd64.tar` 才是镜像文件，不能直接导入 ZIP。镜像适用于 Linux AMD64/x86_64 服务器。
此工作流不上传 GHCR；下载产物保留 30 天，到期可重新运行工作流。

## 导入

通过 1Panel 文件管理将解压后的文件上传至 `/opt/any-listen`。可在该目录执行 `sha256sum -c SHA256SUMS` 校验文件。
在「容器 → 镜像 → 导入」选择 TAR。导入后可看到 `any-listen:<标签>` 和对应提交 SHA 标签。
修改 `.env` 的 `PUBLIC_ORIGIN` 为实际网站地址；保留包内 `ANYLISTEN_TAG` 的值。

## 首次初始化

新在线模式采用单 Node 进程和少量共享 Worker，仅支持在线音乐。管理员在扩展商店安装受管扩展，或通过扩展管理的“本地安装”上传 ALIX 包；在 LX API Source Loader 的扩展设置中导入并勾选脚本，再到账号页面发布配置。编辑草稿不会运行脚本。管理员播放器和普通用户使用同一已发布音源。

此编排使用 `./data:/server/data` 目录挂载，不创建命名卷。`./data` 相对于编排文件所在目录（1Panel 粘贴编排时以实际编排目录为准）。首次部署先在该目录执行 `mkdir -p data && sudo chown 1000:1000 data`，使容器用户可写；重建容器时继续使用同一目录。在线模式不需要 `./music:/music`。

全新部署在包内 `.env` 填写管理员用户名和初始密码：

```dotenv
ADMIN_USERNAME=admin
ADMIN_PASSWORD='这里换成你自己的初始密码'
```

用户名为 3 至 32 位英文字母、数字、点、下划线或连字符，首位须为字母或数字；密码为 1 至 128 个字符。`.env` 中密码用单引号包围，避免 `$` 和 `#` 被解析；若密码包含单引号，请换一个密码或使用下述密码文件方式。

只有账号数据库为空时才自动创建管理员。缺少配置、密码不合规或密码文件无法读取时，启动失败，日志显示原因；修正配置后重新部署即可。已有账号时跳过初始化，更改环境变量不会重置密码，也不会创建另一个管理员。

环境变量可被 Docker 管理员查看，程序不会打印初始密码。首次登录直接进入播放器，可在账号页面自愿修改密码。初始化后删除 `.env` 中的 `ADMIN_PASSWORD`，重新部署容器以清除容器配置中的初始密码，账号保持不变。

仍支持密码文件：在编排中挂载仅管理员可读且容器用户 UID 1000 可读取的文件，设置 `ADMIN_PASSWORD_FILE` 为容器内路径，并移除 `ADMIN_PASSWORD`。两种密码来源不能同时提供。原 `create-admin` 命令也继续可用。

## 启动

在 1Panel「容器 → 编排 → 创建」选择服务器上的 `compose.image.yml`，确保同目录 `.env` 被加载；如果粘贴编排内容，请将镜像标签、网站地址、`ADMIN_USERNAME` 和 `ADMIN_PASSWORD` 直接填入对应位置。直接在 YAML 填密码时，用引号包围，且将密码中的每个 `$` 写成 `$$`，以避免 Compose 插值。
点击启动即可自动初始化。日志出现 `Administrator created` 和 `Any Listen account gateway listening` 表示管理员已创建、网站已启动。
编排设置 `pull_policy: never`，使用本地导入镜像，不拉取 GHCR；不限制容器内存。
在网站管理创建 HTTPS 反向代理，代理至 `http://127.0.0.1:9500`（要求 OpenResty 使用宿主机网络），支持 WebSocket、关闭缓冲，读取超时 600 秒，上传大小 16 MiB。

```bash
docker compose -f compose.image.yml up -d
curl http://127.0.0.1:9500/healthz
```

## 升级

先停止服务并备份整个 `./data`，再导入新 TAR，更新 `.env` 中的镜像标签并重建容器，持续复用同一数据目录。程序没有默认密码；源码测试中的 preview 账号不包含在镜像数据中。升级和重启跳过已有账号的初始化。

运行副本、资源缓存及临时文件写入容器系统临时目录，不需要备份，具体路径见 [数据布局](multi-user.md#数据布局)。
