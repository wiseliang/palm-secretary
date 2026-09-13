# 知识库第一版（v0.17.0）

掌心助理新增全局「知识库」入口，直接只读访问服务器 Obsidian 仓库。原有项目文件、会话与任务流程保持兼容。

## 能力

- 目录树、最近更新、标题/路径/正文/标签的中文关键词搜索。
- Markdown 表格、代码、只读任务列表、常用 Callout、YAML 标题与标签。
- Obsidian 双链、别名、标题锚点、相对 Markdown 链接，重名和缺失链接有明确提示。
- PNG/JPEG/GIF/WebP/AVIF 图片和相对附件路径；外部 HTTPS 图片由浏览器读取。
- `/?knowledge=相对路径` 深链接、复制链接、刷新恢复、浏览器前进后退。
- 桌面侧栏与文章目录、手机可展开目录，浅色和深色模式。
- 页面可见时每 15 秒检查目录；索引缓存最多 10 秒，手动刷新立即重新扫描。此时间表示服务器文件检查，不表示 Syncthing 已同步成功。

## 配置与边界

`KNOWLEDGE_ROOT` 可覆盖根目录，默认 `WORKSPACE_ROOT/projects/obsidian-vault`。生产环境此入口已指向 `/home/codex/obsidian-vault`。允许根入口为符号链接，但不读取仓库内部的链接目录或链接文件。

所有接口 `/api/knowledge*` 复用现有登录和来源校验，返回 `Cache-Control: no-store`，Service Worker 已排除 `/api/`。隐藏点文件/目录、AGENTS.md、sync-conflict 文件；没有写入或删除接口。索引只在内存中，不写入仓库。

单笔记 1 MiB、图片 20 MiB、索引正文总计 64 MiB、最多 5000 篇笔记、20000 个目录项和 20 层目录。超限/暂时不可读文件会显示提示。正文会再次做路径及大小校验。原始 HTML 不执行，SVG 和其他主动内容不作为内联附件提供。

第一版不执行 Dataview、插件脚本、Canvas；笔记嵌入显示为可点击的原文链接。块引用暂不定位。没有在线编辑、AI 问答或对话引用。

## 验证

`npm run check`、`npm run test:all`、`npm run build`。

`test:v029` 检查中文搜索、同名双链、图片、增改删及重命名、路径穿越、符号链接、隐藏文件、大小限制、未登录/跨来源访问、只读 HTTP 边界。

本地视觉验收：先运行 `node tests/knowledge-preview.mjs` 和 `API_PROXY_TARGET=http://127.0.0.1:4599 npm run dev -- --port 4520`，再运行 `tests/knowledge-browser-v029.mjs`（可用 `PLAYWRIGHT_MODULE` / `CHROME_EXECUTABLE` 指定浏览器运行库）。样例及截图仅保存在 `.local-workspace/knowledge-preview`，不上传到真实仓库。

全项目额外的 `tsc --noEmit` 存在历史类型错误；以项目现有 check、构建和回归检查为发布门槛，新模块的类型问题已修正。
