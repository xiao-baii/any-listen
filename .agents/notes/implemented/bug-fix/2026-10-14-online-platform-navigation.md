# Agent Note: 在线资源跨扩展保持音乐平台

Status: implemented

## Problem

在线页面已经传递来源 s，但歌曲来自 online-metadata，歌手来自 singer-metadata。同一平台的完整 ID 不同，例如 online-metadata_wy 与 singer-metadata_wy，切到歌手或切回其他页面时精确匹配失败，页面改选第一个来源。

## Decision

歌曲搜索、歌单搜索、歌单、排行榜和歌手搜索保留完整 ID 优先规则。精确匹配失败时，通过已注册资源找到当前来源，再按平台 id 在目标来源列表选择第一个匹配项。共用 Online/shared.svelte.ts 中的短函数，不拆来源字符串、不按翻译名称推断。

复用各页面现有来源校正流程，用 replaceRoute 写入目标完整 ID 后显示结果。歌手搜索补齐相同流程；没有匹配项时保留既有首项选择或空列表提示。URL 仍是唯一选择状态，不增加持久化、路由包装或重试。歌手详情继续精确匹配完整来源，歌手 ID 不跨扩展复用。

## Alternatives considered

各页面独立记忆来源能保留不同使用习惯，但用户明确选择同平台联动，并且独立记忆会增加状态，因此不采用。

在通用 pushRoute/replaceRoute 中转换来源能集中所有跳转，但详情 ID 属于具体扩展，隐式改来源可能把详情交给错误扩展；仅在五个来源选择页处理。

从完整 ID 截取平台后缀写法更短，但资源 id 和扩展 id 都是字符串，不能靠分隔符猜测边界；使用现有注册列表作为来源事实。

## Testing

`npm run test:singer` 的 15 项测试通过。新增用例直接调用 matchSource，覆盖五个平台在两个扩展之间双向匹配、完整 ID 优先、多个候选顺序、含下划线的扩展和平台 ID、未注册来源、无对应平台、未选来源及空目标列表；复用已有加载工具，不提取组件源码或增加测试框架。

`npm run verify-notes` 通过，10 篇活跃笔记的结构与相对链接有效。

`npm run build:web --workspace=view-main` 通过，仍有未改动组件的 Svelte 警告和包体积提醒。浏览器预览使用构建产物并补入现有 IPC 入口脚本；直接 Node ESM 调用 Vite 的辅助预览构建遇到既有 Less require 兼容问题，没有改动构建配置。

隔离本地账号及两个测试扩展验证网易音乐在歌曲搜索、歌单搜索、顶层歌单、排行榜、歌手搜索之间往返，覆盖顶层歌手搜索入口、排行榜歌曲行歌手入口、作品页及返回。URL 正确转换 online-metadata_wy / singer-metadata_wy，来源按钮保留 active，响应展示由请求 source 生成的 wy 标签，作品 id 始终属于原歌手扩展。未调用真实平台接口或验收出声。

## Consequences

同平台跨页面切换不再因扩展不同而重置；完整来源 ID、详情身份和 URL 单一状态保持不变。增加一个短匹配函数与歌手页的来源校正，其他四页复用已有校正流程。

同平台以扩展声明的 id 一致为前提；名称相同而 id 不同不联动。来源注册被移除后不能推断原平台，沿用已有选择行为。若扩展未来使用不同平台标识，需要明确新的资源契约，不能按名称或字符串后缀推断。

## Prior notes

[在线资源切页](../../implemented/bug-fix/2026-10-14-online-source-navigation.md)部分重叠：本方案替代其“不跨扩展映射”的限制，保留入口透传、URL 单一状态和不携带旧详情参数的决定，不归档旧篇。[歌手播放](../../implemented/feature/2026-10-09-singer-playback.md)的入口和详情契约继续有效；[歌手元数据](../../implemented/feature/2026-10-11-singer-metadata.md)的独立扩展、平台声明与顺序继续有效；其他活跃笔记不涉及来源选择。
