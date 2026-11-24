# AGENTS.md

`geomix-extension` 是 GeoMix v2.2 的独立伴生 Chrome 扩展仓库（Manifest V3 + Vite + TypeScript + React + Shadow DOM + Vitest），负责将 GeoMix 控制台生成的 `L2_EXTENSION` 渠道变体在用户本地已登录浏览器中一键写入国内内容平台草稿箱，并在用户手动发布后捕获公网 URL 回传至 GeoMix 主服务。

在开始编码前，请先阅读 [MVP 需求规格与技术架构设计（docs/GeoMix-Extension-MVP需求与架构设计.md）](./docs/GeoMix-Extension-MVP需求与架构设计.md) 与主仓 [`yexiu700/geomix#371`](https://github.com/yexiu700/geomix/issues/371)。

---

## 不可妥协红线

### 1. 安全与合规红线（违反即拒合）

- **严禁读取/上传第三方平台 Cookie**：禁止在 `manifest.json` 申请 `cookies` 权限，禁止通过 `document.cookie` 收集或上报任何第三方网站凭据。
- **严禁自动点击平台最终「发布」按钮**：所有 Platform Adapter 最高权限仅限**填充标题/正文、转存图片、保存草稿箱（Draft）**；最终发布必须由人工审阅并手动触发。
- **最小化 Manifest 权限**：
  - 仅允许声明 `storage`、`tabs`、`activeTab`、`scripting`；
  - `host_permissions` 严格限定在已支持平台域名与用户配置的 GeoMix API 域名，**禁止申请 `<all_urls>` 或 `http://*/*`、`https://*/*` 泛通配符权限**（确保 Chrome Web Store 审核一次通过）。
- **Token 安全存储**：`gmext_` 配对 Token 仅保存在 `chrome.storage.local`（不写入 `localStorage`、不写入网页 DOM、不打印至 `console.log`），注销/解绑时必须立即清除。
- **公网 URL 回传白名单校验**：URL 捕获器必须按平台正则白名单校验已发布链接格式（仅允许 `https://` 且匹配对应平台文章页域名/路径），禁止回传编辑页草稿 URL、私网地址或带敏感 Query 参数的链接。
- **公仓零脱敏泄漏**：严禁在代码、测试 Fixture、Issue、PR、Commit 中出现真实环境域名、服务器标识、测试品牌名、真实账号或真实 `gmext_` Token。

### 2. Git、PR 与 CI 纪律

- 仓库初始化提交完成后，所有开发均从最新 `origin/main` 拉出独立功能分支（如 `feat/batch-0-scaffold`、`feat/adapter-zhihu`）并通过 Pull Request 交付，**严禁直接推 `main`**。
- 推荐技术栈固定：`pnpm` + `Vite` + `@crxjs/vite-plugin`（或等价轻量 MV3 构建配置）+ `TypeScript (strict)` + `React 19` + `Vitest` + `ESLint / Prettier`。
- 每个 PR 合入前必须通过：
  ```bash
  pnpm lint && pnpm typecheck && pnpm test && pnpm build
  ```
- **禁止在 `docs/` 下提交大体积图片二进制或 `.crx`/`.zip` 构建产物**。

---

## 架构约定与契约对齐

1. **与主仓契约单一真相源**：
   - 本仓 `src/shared/bridge-contract.ts` 必须与主仓 `yexiu700/geomix` 的 `packages/shared/src/extension-bridge.ts`（Issue `#367` / `#371`）保持字段与 Zod 校验 100% 对齐。
   - 仅调用以下 3 个薄端点（使用 `Authorization: Bearer gmext_...`）：
     - `GET /api/v2/extension/me`
     - `GET /api/v2/extension/tasks`
     - `POST /api/v2/extension/tasks/:taskId/confirm-published`
2. **Adapter 隔离原则**：
   - 每个内容平台（`zhihu` / `toutiao` / `smzdm`）独立维护在 `src/adapters/<platform>/` 下，实现统一的 `PlatformDraftAdapter` 接口（`detectEditor` / `injectDraft` / `extractPublishedUrl`），相互零耦合。
   - 每个 Adapter 必须配套独立 DOM Fixture 单元测试（`*.spec.ts`），以便平台页面改版时快速定位失效选择器并单点热修。
3. **UI 隔离原则**：
   - 页面内注入的「已发布 URL 捕获确认浮条」必须挂载在 **Shadow DOM** 内部，避免污染或受宿主平台 CSS 样式影响。
   - 图片防盗链中转必须在扩展上下文（Background Service Worker / Content Script）内将图片拉取为 `Blob`/`File`，经 `DataTransfer` 模拟粘贴或触发平台原生 `<input type="file">` 上传，严禁直接塞入易失效的第三方外链 URL。

---

## 目录规范（Batch 0 落地目标）

```text
geomix-extension/
├── AGENTS.md
├── README.md
├── docs/
│   └── GeoMix-Extension-MVP需求与架构设计.md
├── manifest.config.ts          # MV3 最小权限清单定义
├── src/
│   ├── shared/                 # Bridge 协议契约、存储封装、URL 校验工具
│   ├── background/             # Service Worker：API 调用、图片拉取、任务状态路由
│   ├── popup/                  # Popup / SidePanel：Token 配对、待发队列、一键推草稿
│   ├── content/                # 通用注入运行时与 Shadow DOM URL 捕获浮条
│   └── adapters/
│       ├── types.ts            # 统一 PlatformDraftAdapter 接口
│       ├── zhihu/              # 知乎专栏 / 回答草稿箱适配 + DOM 单测
│       ├── toutiao/            # 今日头条文章草稿箱适配 + DOM 单测
│       └── smzdm/              # 什么值得买好文草稿箱适配 + DOM 单测
└── tests/                      # 集成测试与 Manifest 权限安全守卫测试
```
