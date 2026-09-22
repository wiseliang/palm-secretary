# 掌心助理：磁盘与 Mihomo 运维说明

## 2026-09-23 故障复盘

掌心助理 Web、API 和 Nginx 当时均正常，但根分区可用空间降至 4 GiB
任务安全线以下，因此普通任务与上传被主动暂停。主要增长项不是用户项目，而是日志和可再生成缓存：

- 服务器 Mihomo 配置停留在旧版本，所选代理节点失效；本机 Clash Verge 已有更新配置。
- `codex-quota-trigger.timer` 经 `127.0.0.1:7897` 高频检查 ChatGPT 用量，失败重试产生大量 Mihomo 警告。
- Mihomo 使用未限制大小的 Docker `json-file` 日志，单文件增长到约 678 MB。
- systemd journal 增长到约 955 MB。
- `/etc/logrotate.d/rsyslog` 缺少 `su root syslog`，与 `/var/log` 的 `root:syslog 0775` 权限不匹配，导致 syslog 轮转被跳过。
- Codex 历史安装包和 npm 下载缓存继续占用额外空间。

## Mihomo 同步约定

掌心助理的 Codex 必须通过本机 Mihomo 代理访问外部服务：

```text
HTTP_PROXY=http://127.0.0.1:7897
HTTPS_PROXY=http://127.0.0.1:7897
ALL_PROXY=http://127.0.0.1:7897
```

服务器节点失效时，可从已验证可用的本机 Clash Verge 生成配置同步节点、代理组、规则和 DNS 设置。
同步时必须保留服务器专用限制：

- `mixed-port: 7897`
- `allow-lan: false`
- `bind-address: 127.0.0.1`
- `external-controller: ''`

不得把订阅地址、节点凭据、认证令牌或本地控制密钥提交到 Git。新配置应先用 Mihomo `-t` 校验，保留旧配置备份，重启后分别验证 ChatGPT、OpenAI API、掌心助理健康接口和监听地址。

## 安全清理顺序

1. 确认 `/opt/palm-secretary/current`，保留当前 release 和一个完整回滚 release。
2. 使用 `/usr/local/libexec/palm-storage-cleanup plan` 生成确定性计划。
3. 将 journal 收缩到 200 MB 左右。
4. 轮转 syslog；Ubuntu 的 rsyslog 配置需包含 `su root syslog`。
5. 清除 `codex` 用户的 npm 下载缓存。
6. 仅在确认没有进程打开文件后删除未使用的旧 Codex 包。
7. 最后复查根分区、API/Web 状态、健康接口和代理访问。

永不把 `/home/codex/workspace/.palm`、`/home/codex/workspace/projects`、数据库、容器卷或其他业务目录当作缓存删除。

## 预防措施

- 根分区低于 6 GiB 时预警，低于 4 GiB 时暂停新任务和上传。
- Docker 日志应设置 `max-size` 和 `max-file`，避免代理或聊天容器无限写入。
- 高频外部检查必须有失败退避，认证头不要直接出现在命令行参数中。
- 每次部署成功后只保留当前 release 和一个回滚点。
