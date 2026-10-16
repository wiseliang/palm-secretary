# 独立 HTTPS 成果下载入口

状态：代码准备完成，默认关闭；DNS、公开受信任证书与部署验收完成后才启用。

## 流程

主站 `/api/files/download` 验证现有登录和文件访问路径，再签发有效期最多 120 秒、绑定具体项目及文件的下载票据，302 跳转至独立下载域名。票据只保存会话哈希，不能提取登录 Cookie。注销会话后票据失效。浏览器与 Android DownloadManager 继续使用原有下载链接，无需共享父域 Cookie。

直连接口支持单段 Range 请求；保持现有安全文件路径检查。主站关闭时保持原下载方式。票据接口关闭请求 URL 日志，Nginx 不记录此入口访问日志。

## 待执行基础设施步骤

1. Cloudflare DNS 添加 **A** 记录：`download` → `43.143.235.124`，代理状态 **仅 DNS（灰云）**，TTL 自动。不要修改主站记录。
2. 在独立 HTTP 虚拟主机提供 `/var/lib/palm-acme/.well-known/acme-challenge/`，通过 ACME webroot 签发覆盖 `download.wiseliang.cloud` 的公开可信证书。现有 Cloudflare Origin CA 证书不可用于直连浏览器；旧 TrustAsia 证书已过期且不覆盖下载域名。
3. 安装 `deploy/nginx-download.conf`，执行 `nginx -t` 后 reload；配置证书自动续期和续期后 nginx reload。
4. 在独立 release 构建并通过测试、确认无运行中/待核对任务且备份状态后切换。为 API 添加 `DOWNLOAD_ORIGIN=https://download.wiseliang.cloud` 并重启。
5. 验证主站未登录下载拒绝访问、直连无票据/篡改/过期/注销后票据拒绝访问；有效票据下载及 Range 返回 200/206；检查 Content-Disposition、文件校验和；手机实测与主站下载对比。

## 回退

删除 API 的 `DOWNLOAD_ORIGIN` 并重启 API，主站立即恢复原路径下载。独立域名不提供登录、管理或任意文件目录。

当前会话未找到 DNS 管理权限或可用 API 凭据，因此没有修改 DNS、替换线上证书或启用直连跳转。

## 已完成验证

- `npm run build:server`
- `node tests/download-ticket.mjs`：签名、防篡改、过期、受众绑定、注销撤销和 Range 解析。
- `node tests/direct-download.mjs`：真实 HTTP 路由验证主站登录校验、302、完整下载、206/416、路径越界拦截、注销撤销、日志不包含票据及关闭配置后的原下载回退。
- 公网域名与手机网络实测待 DNS、证书和部署完成后执行；本地测试不代表线上已启用或已提速。
