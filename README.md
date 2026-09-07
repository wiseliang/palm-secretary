# 掌心助理

掌心助理是面向手机与网页的 Codex 助理客户端，包含网页/API 服务、Android 客户端和 HarmonyOS NEXT 客户端源码。

## 目录

- `codex-secretary/`：网页前端与 API 服务（版本以 `package.json` 为准，当前发布候选 v0.15.8）
- `palm-secretary-android/`：Android WebView 客户端
- `palm-secretary-harmony/`：HarmonyOS NEXT 客户端

Web/API 与原生客户端独立编号。Android 当前配置 v0.13.9；HarmonyOS v0.1.1 为待真机验证版本，不代表与 Web/API 相同的验收状态。

## 安全说明

仓库不包含服务器环境变量、登录凭据、证书私钥、签名材料、构建缓存或安装包。部署前请根据各项目的示例配置创建本地配置。
