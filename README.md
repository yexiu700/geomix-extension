<div align="center">

<br />

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./assets/brand/formal_logo.svg" />
  <source media="(prefers-color-scheme: light)" srcset="./assets/brand/formal_logo_light.svg" />
  <img alt="GeoMix" src="./assets/brand/formal_logo.svg" width="240" />
</picture>

<br />
<br />

**GeoMix 渠道草稿助手 — L2 Chrome 扩展（Manifest V3）**

[![CI](https://github.com/yexiu700/geomix-extension/actions/workflows/ci.yml/badge.svg)](https://github.com/yexiu700/geomix-extension/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/yexiu700/geomix-extension?label=Release)](https://github.com/yexiu700/geomix-extension/releases)
![Manifest V3](https://img.shields.io/badge/Chrome-Manifest%20V3-4285F4?logo=googlechrome&logoColor=white)
![TypeScript 5](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)

[GeoMix 主仓 (`yexiu700/geomix`)](https://github.com/yexiu700/geomix) · [下载最新版安装包（Releases）](https://github.com/yexiu700/geomix-extension/releases)

</div>

---

## 简介

**GeoMix 渠道草稿助手**是 [GeoMix](https://github.com/yexiu700/geomix) v2.2 官方伴生 Chrome 扩展（Manifest V3），用于打通国内主流内容平台的「**本地登录态一键写草稿箱 → 人工审阅发布 → Shadow DOM 捕获公网 URL 回传 GeoMix 开启 T+1 抓取体检与 T+7/14/30 自动复测**」完整闭环。

## 支持的发布器

| 渠道枚举 (`provider`) | 平台 | 支持的编辑页 | 能力说明 |
| :--- | :--- | :--- | :--- |
| `ZHIHU_EXT` | **知乎** | `zhuanlan.zhihu.com/write`、`p/<id>/edit`、`zhihu.com/question/<id>` | 写入专栏文章 / 问题回答草稿（Draft.js）与本地转存配图 |
| `TOUTIAO_EXT` | **今日头条** | `mp.toutiao.com/profile_v4/graphic/publish`、`.../edit` | 写入头条号图文草稿与本地转存配图 |
| `SMZDM_EXT` | **什么值得买** | `post.smzdm.com/tougao/`、`post.smzdm.com/edit/<id>` | 自动跳转/复用 `/edit/<id>` 编辑页并写入 Vue + TipTap 草稿区 |

## 核心安全原则（不可妥协）

1. **零服务端 Cookie / 零模拟登录**：完全复用用户在本地 Chrome 浏览器中的平台登录态，绝不读取、存储或向任何服务端上传第三方平台 Cookie。
2. **仅推草稿箱，绝不自动点击最终「发布」**：插件只负责标题/正文注入与图片本地中转防盗链，最终发布动作必须由用户在平台原生编辑器内肉眼审阅后手动确认。
3. **最小权限配对 Token**：通过 GeoMix 控制台签发的 `gmext_` 专用 Token 鉴权，仅允许调用 `/api/v2/extension/*` 三个薄端点（身份校验、拉取待发任务、回传已发布 URL），无法触发计费、修改品牌或访问任何 CMS 凭证。
4. **独立仓解耦发版**：与主仓 [`yexiu700/geomix`](https://github.com/yexiu700/geomix) 解耦，合入 `main` 后由 GitHub Actions 自动测试、打包并发布至 [GitHub Releases](https://github.com/yexiu700/geomix-extension/releases)。

## 快速安装（Chrome 本地加载）

1. 前往 [Releases 页面](https://github.com/yexiu700/geomix-extension/releases) 下载最新的 `geomix-extension-v*.zip` 并解压；
2. 打开 Chrome 地址栏输入 `chrome://extensions`，开启右上角**「开发者模式」**；
3. 点击**「加载已解压的扩展程序」**，选择解压后的目录（包含 `manifest.json`）；
4. 在 GeoMix 控制台「品牌资产（国内市场）→ 国内 L2 Chrome 扩展配对」生成 `gmext_` 配对 Token，填入扩展弹窗即可使用。

## 本地开发与打包

```bash
pnpm install --frozen-lockfile
pnpm lint          # ESLint 校验
pnpm typecheck     # TypeScript strict 检查
pnpm build         # 构建 dist/（popup + background + content）
pnpm test          # Vitest 全量单测（含 MV3 安全红线 AST 守卫与 Mock Bridge 回归）
pnpm run pack      # 打包确定性 Chrome 扩展 ZIP 至 release/
```

## 文档导航

- [编码代理开发手册（AGENTS.md）](./AGENTS.md)
- [MVP 需求规格与技术架构设计（docs/GeoMix-Extension-MVP需求与架构设计.md）](./docs/GeoMix-Extension-MVP需求与架构设计.md)
- [发布与真机验收清单（docs/发布与真机验收清单.md）](./docs/发布与真机验收清单.md)
- 主仓关联设计：[`yexiu700/geomix` v2.2 Epic #375](https://github.com/yexiu700/geomix/issues/375) · [Extension Bridge 后端 #371](https://github.com/yexiu700/geomix/issues/371)
