# Agent Note: 在线资源切页保留音乐源

Status: implemented

## Problem

在线资源顶部切换页面仅传递 t，丢失已选音乐源 s，排行榜、歌单和搜索随即回退到第一个源；歌手页进入歌手搜索也丢失 s。

## Decision

顶部导航和歌手搜索入口显式携带当前 s，沿用 URL 作为选中源的唯一状态。只携带源，不把上一页的作品 id、分页或搜索类型带到另一种页面。目标页不支持该源时继续使用现有回退逻辑。

来源原值直接传给路由；未选来源时由现有 buildQueryParams 过滤 undefined，不补空字符串。

## Alternatives considered

在 pushRoute 统一继承源可以减少调用方重复，但该函数还用于详情、分页及显式指定来源的跳转，隐式合并会改变无关调用的语义。因此仅修正丢失参数的两处导航入口。

增加全局或持久化偏好可以在刷新后独立恢复来源，但会与 URL 形成两套状态，也超出切页保留选择的需求，因此复用现有路由参数。

正则提取组件回调后用 VM 执行能检查参数传递，但测试依赖组件源码写法，也不验证实际 Svelte 交互。两处直接参数透传不保留这套测试包装，也不另建 helper 或静态源码断言替代它。

## Testing

检查调用链：Params 接受 undefined，buildQueryParams 过滤 null/undefined；两个入口只传目标页参数和当前源。删除原 onlineNavigation.test.cjs，未新增运行时分支或独立测试框架。

`npm run build:web --workspace=view-main` 通过，构建仍有未改动组件的 Svelte 警告和包体积提醒。未进行浏览器交互或真实扩展端到端验证。

## Consequences

切换到支持同一个完整源标识的页面时无需重新选择，沿用现有目标页的能力校验及回退。不同扩展的同名平台不自动映射，不新增跨会话偏好。删除测试包装减少源码格式耦合，但切页行为仍缺少浏览器端回归覆盖。

## Prior notes

检索在线、资源、选中及 resource：歌手播放笔记与本次入口部分重叠，见[歌手筛选播放](../../implemented/feature/2026-10-09-singer-playback.md)，其播放和资源契约继续有效；歌手元数据、账号资源和缓存笔记不涉及导航选择，无需取代或归档。
