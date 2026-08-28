# 掌心助理 v0.4.0 工作台升级指令

将掌心助理从 v0.3.x 升级到 v0.4.0。新增持久任务中心、任务/对话搜索、项目重命名、文件分类搜索和多文件顺序上传。不得扩大 Linux/root 权限，不得把 Palm Server Ops 密钥或 OpenClaw Token 写入网页、Android App 或 palm-secretary 环境变量；不得修改 OpenClaw、QQ/NapCat、Cloudflare、证书、Mihomo 或其他服务。

## 1. 只读前置检查

1. 校验 `palm-secretary-v0.4.0-20260824.tar.gz` 与随包 SHA256。
2. 确认包内 `package.json` 版本为 `0.4.0`，包含任务中心代码、`server/project-store.ts` 和本指令。
3. 记录 current 指向、api/web/nginx 状态、RestartCount、监听端口、根分区空间和当前 release 列表。
4. 根分区可用空间必须至少 6GB；不足则停止并只报告旧 release 清理候选，不删除任何内容。
5. 备份 `/etc/palm-secretary/app.env`（只复制，不读取或输出内容）、`/home/codex/workspace/.palm/state.json` 和旧 current。备份目录 root-only、0700。

## 2. 安装

1. 解压到临时目录，执行 `deploy/install-release.sh`。
2. 不得重写 `/etc/palm-secretary/app.env`，不得修改 Nginx 配置；v0.3.3 已有的上传超时、100MB、WebSocket 和安全头配置全部保持。
3. 安装完成后只重启 `palm-secretary-api.service` 与 `palm-secretary-web.service`。
4. 不重启 Nginx、OpenClaw Gateway、Palm Server Ops、Docker、NapCat、OneBot、MySQL 或 Mihomo。

## 3. 状态迁移

API 首次启动会把 `/home/codex/workspace/.palm/state.json` 从 version 2 自动迁移为 version 3，并新增空的 `tasks` 数组。迁移必须保留原 projects、threads、模型与推理强度设置。禁止手工清空或重建 state.json。

验证：JSON 可解析、version=3、projects/threads 数量与升级前一致、tasks 为数组、文件仍为 codex 用户可读写且权限不放宽。

## 4. 验收

1. API `/api/health` 返回 200，Web 与 8088 入口返回 200。
2. 登录网页或 Android App，确认旧项目、旧对话、文件和模型设置仍存在。
3. 在一个项目发送测试任务，完成后“记录”页显示任务中心卡片且状态为“已完成”；刷新页面后仍存在，点击卡片能打开对应对话。
4. 创建第二个项目，确认第一个项目的任务、对话和文件不会出现。
5. 任务/对话搜索、项目重命名可用。
6. 文件页可按“全部/上传/成果”筛选并搜索；选择 2 个小 TXT 能顺序上传，均显示附件卡片，发送后 Codex 能读取。
7. 停止一条运行中任务后，任务状态应变为“已停止”；若当前 Codex 版本只发 completed 而不发 interrupted，明确报告兼容性，不擅自改协议。
8. Codex 余量、模型切换、单文件下载、最新成果快捷下载仍可用。
9. 4510/4511/8088/7897/4520 保持仅回环；12236 保持 `127.0.0.1` 与 `[::1]`；无新增公网端口。
10. api/web RestartCount=0，近 10 分钟无 ERROR；OpenClaw、Palm Server Ops、QQ/NapCat、OneBot、微信、Nginx、MySQL、Docker 状态不变。
11. 部署后根分区至少保留 5GB；不足则立即回切旧 current，不自动删除 release。

## 5. 回滚

任一核心验收失败：精确恢复旧 current 和备份的 state.json，只重启 palm-secretary-api/web，复验旧版本。保留失败 release 供排障，不删除用户文件。最终汇报版本、迁移前后计数、服务、端口、日志、磁盘和回滚点；不得输出密码、哈希、Cookie、Token、auth.json、私钥、代理节点或任何桥接密钥。
