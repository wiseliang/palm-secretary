# 掌心助理 v0.6.0 易用性升级指令

将掌心助理从 v0.5.0 升级到 v0.6.0。新增安全在线文件预览、回复结构化排版与一键复制、任务耗时/附件/成果摘要、按项目保存未发送草稿，以及断线与磁盘告警。不得扩大 Linux/root 权限，不得修改 OpenClaw、Palm Server Ops、Nginx、证书、Cloudflare、QQ/微信/NapCat、Docker、MySQL、Mihomo、防火墙或其他服务。

## 前置、清理与备份

1. 校验发布包 SHA-256、tar 路径安全、`package.json` 版本 0.6.0；确认随包集成测试标记为 `PALM_V06_INTEGRATION_OK`。
2. 记录 current、state.json 版本与项目/对话/任务计数、api/web PID/RestartCount、固定监听端口、Nginx 配置 SHA-256/mtime 和根分区空间。
3. 为构建留出空间：仅可精确删除已确认非 current 的旧 release `/opt/palm-secretary/releases/20260824T091231Z`。删除前必须确认 realpath 位于 `/opt/palm-secretary/releases/`、不是 current、没有进程打开其文件；不得删除 v0.4 `/opt/palm-secretary/releases/20260824T141030Z`、当前 v0.5 `/opt/palm-secretary/releases/20260824T145408Z` 或任何其他目录。
4. 清理后根分区可用空间须至少 6GB，否则停止部署。
5. 新建 root-only 0700 备份目录；复制 app.env（不读取内容）、state.json，并记录旧 current 和服务基线。

## 安装

1. 解压到精确临时目录，执行随包 `deploy/install-release.sh`。本机已有 Nginx 配置，线上 Nginx 文件 SHA-256/mtime 必须保持不变，Nginx 不 reload/restart。
2. 仅重启 `palm-secretary-api.service` 与 `palm-secretary-web.service`；不得重启其他服务。
3. v0.6 不改变 state schema；部署前后 state version、项目/对话/任务计数必须保持一致。

## 自动验收

1. current 与运行包版本均为 0.6.0；`/api/health`、Web、8088 均返回 200。
2. 使用已有本机认证方式验证：上传临时 TXT 后 `/api/files/preview` 返回 200、`Content-Type` 为 text/plain、`Content-Disposition` 为 inline 且不泄露内部 UUID；不支持的二进制类型返回 415。删除临时测试文件。
3. 4510/4511/8088/7897/4520 仅回环；12236 仅 127.0.0.1 与 [::1]；无新增公网端口。
4. api/web active、NRestarts=0，近 10 分钟日志无新 ERROR；Nginx、Palm Server Ops、OpenClaw、Docker、NapCat、OneBot、QQ/微信及其他未授权服务 PID/启动时间不变。
5. 部署后根分区至少 5GB，否则恢复旧 current/state，仅重启 api/web。
6. 登录网页交互项不得伪造：结构化回复、复制、草稿恢复、任务摘要和预览按钮列为用户已完成的本地浏览器验收。

## 回滚与收尾

核心自动验收失败时恢复旧 current 和 state.json，仅重启 api/web，保留失败 release。成功后精确删除上传包和临时 staging；保留当前 v0.6、v0.5 回滚点和 v0.4 二级回滚点。最终不得输出任何凭据、Cookie、用户内容或 app.env 内容，完成标记为 `PALM_V06_DEPLOYED`。
