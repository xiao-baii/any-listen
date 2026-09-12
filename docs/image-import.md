# 1Panel 镜像文件部署

在 GitHub Actions 的 Multi User 成功运行页底部 Artifacts 下载 `any-listen-<标签>-linux-amd64`，解压下载的 ZIP。
包内 `any-listen-linux-amd64.tar` 才是镜像文件，不能直接导入 ZIP。镜像适用于 Linux AMD64/x86_64 服务器。
此工作流不上传 GHCR；下载产物保留 30 天，到期可重新运行工作流。

## 导入

通过 1Panel 文件管理将解压后的文件上传至 `/opt/any-listen`。可在该目录执行 `sha256sum -c SHA256SUMS` 校验文件。
在「容器 → 镜像 → 导入」选择 TAR。导入后可看到 `any-listen:<标签>` 和对应提交 SHA 标签。
修改 `.env` 的 `PUBLIC_ORIGIN` 为实际网站地址；保留包内 `ANYLISTEN_TAG` 的值。

## 首次初始化

已有数据时请复用已有数据卷，不要重新创建管理员。此编排固定挂载 `any-listen-data`；如果旧部署使用其他卷，先修改 `compose.image.yml` 的卷名称指向旧卷。
全新部署在服务器终端执行以下命令。将 `<标签>` 替换成包内 `.env` 的 `ANYLISTEN_TAG` 值。

```bash
cd /opt/any-listen
docker volume create any-listen-data
read -rsp '管理员初始密码（12 至 128 位）: ' ADMIN_PASSWORD
printf '\n'
(umask 077; printf '%s' "$ADMIN_PASSWORD" > admin-password.txt)
unset ADMIN_PASSWORD
chown 1000:1000 admin-password.txt
docker run --rm --pull never \
  -v any-listen-data:/data \
  -v /opt/any-listen/admin-password.txt:/run/admin-password:ro \
  -e ADMIN_PASSWORD_FILE=/run/admin-password \
  any-listen:<标签> create-admin admin
```

确认 `Administrator created` 后删除 `admin-password.txt`。首次登录强制改密。

## 启动

在 1Panel「容器 → 编排 → 创建」选择服务器上的 `compose.image.yml`，确保同目录 `.env` 被加载；如果粘贴编排内容，请将镜像标签和网站地址直接填入。
编排设置 `pull_policy: never`，使用本地导入镜像，不拉取 GHCR；不限制容器内存。
在网站管理创建 HTTPS 反向代理，代理至 `http://127.0.0.1:9500`（要求 OpenResty 使用宿主机网络），支持 WebSocket、关闭缓冲，读取超时 600 秒，上传大小 16 MiB。

```bash
docker compose -f compose.image.yml up -d
curl http://127.0.0.1:9500/healthz
```

## 升级

先备份数据卷，再导入新 TAR，更新 `.env` 中的镜像标签并重建容器，持续复用同一数据卷。不要删除数据卷。
程序没有生产默认账号；源码测试中的 preview 账号不包含在镜像数据中。管理员初始化仍需上述一次性终端操作。
