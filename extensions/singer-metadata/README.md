# 歌手元数据

独立提供网易云、QQ音乐、酷狗、酷我、咪咕的歌手搜索和分页作品。无需 Online Metadata，也不提供音频播放地址；播放继续使用管理员配置的播放音源。

## 安装与更新

先更新支持通用扩展发布及歌手接口的主程序。管理员在扩展管理选择“本地安装”，上传 `singer-metadata_v0.1.1.alix`，然后到账号页手动“发布配置”。所有账号使用已发布版本。更新时导入新版包并再次发布。没有商店、预装或自动更新任务。

## 构建与验证

在仓库根目录运行 `npm run build:singer-extension`。包输出到本目录 `dist/`，使用现有安装器支持的未签名 ALIX 格式；后续更新保持相同签名身份。

`npm run test:singer-extension` 运行离线样例测试；`npm run test:singer-extension:live` 请求五个平台真实接口，验证搜索、作品分页和必要播放字段。实时接口可能受到平台限流或区域限制，错误会直接返回页面，不以普通歌曲搜索回退。

咪咕歌手搜索固定每页 20 条；作品单页最多请求 30 条，播放时由主程序逐页取齐。作品范围和总数以平台接口返回为准。

## 接口参考

歌曲字段沿用 [Online Metadata](https://github.com/any-listen/any-listen-extension-online-metadata) 的数据契约（Apache-2.0）。请求路径和参数通过平台真实响应验证；参考 [QQMusicApi](https://github.com/L-1124/QQMusicApi) 的歌手接口及 [KuGouMusicApi](https://github.com/MakcRe/KuGouMusicApi) 的搜索协议。本扩展不引入这些项目作为运行依赖。
