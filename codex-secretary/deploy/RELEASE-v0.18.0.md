# v0.18.0 知识库引用问答

2026-09-09 通过直接 SSH 发布至 https://ai.wiseliang.cloud 。

- Release：`/opt/palm-secretary/releases/20260909-v0.18.0-knowledge-reference`
- 上一版本：`/opt/palm-secretary/releases/20260908-v0.17.0-knowledge`
- 状态备份：`/opt/palm-secretary/backups/20260909-v0.18.0-knowledge-reference`
- 源码归档 SHA256：`bedc3b218b2e9ff0b4c0f6789451ceb75fd6a7a1228ab4859a8cedda793046c6`

支持整篇或选中段落引用，预览确认后带入对话，保留已有问题及附件。引用快照随草稿和历史保存，重试沿用原始快照；原文链接可点击。不会自动发送或改写 Obsidian 笔记。

本地和 Linux 的 check、全部回归（含 v030）、生产构建均通过。模拟浏览器测试通过引用、取消、草稿恢复、发送快照、历史恢复、移动端及深色模式。保留已有聊天图片 lint 警告。

线上确认 API/Web 健康、真实笔记读取和搜索、路径隔离、引用预览及发送入口。服务器模型账号于 2026-09-09 重新登录后，真实引用任务执行完成：历史保留引用快照，回答仅依据引用内容概括并生成可点击的原文链接。验收项目已归档，原始笔记未修改。

发布源基于已上线 v0.17.0 独立整理，未包含工作区并行的 Luna Reserve 改动。依赖图不变，依赖包文件与上一 release 使用硬链接，未运行依赖更新。服务健康且磁盘剩余约 5.5 GiB。

回滚先确认无运行或待核对任务，再切回上一 release 并重启 API/Web；保留最新状态，不以旧备份覆盖新任务。
