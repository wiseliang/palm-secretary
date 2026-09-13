# v0.17.0 知识库第一版

2026-09-09（Asia/Shanghai）已通过直接 SSH 发布到 https://ai.wiseliang.cloud 。

- 当前 release：`/opt/palm-secretary/releases/20260908-v0.17.0-knowledge`
- 上一 release：`/opt/palm-secretary/releases/20260908-v0.16.1-chat-stability`
- 应用状态备份：`/opt/palm-secretary/backups/20260908-v0.17.0-knowledge`
- 源码归档 SHA256：`88805eee86f5ca8ab8b092f616c01b3b7d68821c2ff57754f585c5fd9b56be04`
- 只读仓库入口：`/home/codex/workspace/projects/obsidian-vault`，实际为 `/home/codex/obsidian-vault`。

本地和 Linux 环境的 check、完整回归（含 v029）及构建通过。Linux 回归使用独立 validation 目录，并补充 Android 的 MainActivity.java / AndroidManifest.xml / app/build.gradle 与 Harmony 的 Index.ets，满足旧测试跨项目的源码读取依赖。

浏览器验收覆盖目录、中文搜索、双链与中文锚点、表格和 Callout、图片、脚本不执行、刷新恢复、浏览器后退、缺失链接提示、深色模式以及 320px/390px 手机布局。线上真实登录态下确认 1 篇笔记可读、可搜索，桌面与手机页面无脚本错误；验证会话已注销。未修改 Obsidian 文件。

本地开发服务器 Lighthouse：Accessibility 95，Performance 39（开发模式，不作为生产性能分数）。两项无障碍问题来自已有的系统状态提示对比度与项目选择器 accessible name；新知识库无命中项。check 保留已有聊天图片的 next/no-img-element 警告。全项目额外 tsc --noEmit 有历史类型错误，不属于本次新增模块。

回滚时先确认无运行中或待核对任务，再把 current 切回上一 release 并重启 API/Web。两版状态格式兼容，保留当前状态，勿直接用旧备份覆盖新任务数据。备份和 release 均未删除。
