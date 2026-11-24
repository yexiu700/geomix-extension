# GeoMix Extension（L2 本地内容分发助手）

GeoMix 官方伴生 Chrome 扩展（Manifest V3），用于打通国内主流内容平台（MVP 首期：**知乎 / 今日头条 / 什么值得买**）的「本地登录态一键写草稿箱 → 人工审阅发布 → 自动捕获公网 URL 回传 GeoMix 开启 T+1 体检与 T+7/14/30 自动复测」闭环。

## 核心设计原则（不可妥协）

1. **零服务端 Cookie / 零模拟登录**：完全复用用户在本地 Chrome 浏览器中的平台登录态，绝不读取、存储或向任何服务端上传第三方平台 Cookie。
2. **仅推草稿箱，绝不自动点击最终「发布」**：插件只负责标题/正文注入与图片本地中转防盗链，最终发布动作必须由用户在平台原生编辑器内肉眼审阅后手动确认。
3. **最小权限配对 Token**：通过 GeoMix 控制台签发的 `gmext_` 专用 Token 鉴权，仅允许调用 `/api/v2/extension/*` 三个薄端点（身份校验、拉取待发任务、回传已发布 URL），无法触发计费、修改品牌或访问任何 CMS 凭证。
4. **独立仓解耦发版**：与主仓 [`yexiu700/geomix`](https://github.com/yexiu700/geomix) 解耦，便于高频响应内容平台编辑器 DOM 改版热修与 Chrome Web Store 独立打包审核。

## 文档导航

- [编码代理开发手册（AGENTS.md）](./AGENTS.md)
- [MVP 需求规格与技术架构设计（docs/GeoMix-Extension-MVP需求与架构设计.md）](./docs/GeoMix-Extension-MVP需求与架构设计.md)
- 主仓关联设计：[`yexiu700/geomix` v2.2 Epic #375](https://github.com/yexiu700/geomix/issues/375) · [Extension Bridge 后端 #371](https://github.com/yexiu700/geomix/issues/371)
