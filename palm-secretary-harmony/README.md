# 掌心助理 HarmonyOS NEXT

HarmonyOS NEXT 原生 HAP 客户端，使用 ArkTS、ArkUI 与 ArkWeb，连接现有服务：

`https://ai.wiseliang.cloud/`

## 当前版本

`0.1.1`，已实现：

- HarmonyOS Stage 模型与 EntryAbility
- ArkWeb 安全加载 HTTPS 页面
- JavaScript、DOM Storage、在线图片
- 禁止混合内容和 Web 文件系统直接访问
- 原生加载进度、离线页、重试
- 返回键浏览历史
- 回到前台时触发网页 `palm-resume` 同步
- 接收系统分享的单个文件/图片/视频/文本
- 通过受限原生临时资源把分享文件送入网页附件区
- 分享文件读取失败与超过 32MB 时显示明确提示；更大文件请在应用内选择上传

## 尚需 DevEco Studio 真机完成

本机尚未安装 DevEco Studio/HarmonyOS SDK，因此以下能力已预留但必须在 DevEco 中按目标 API 校准并真机验证：

1. ArkWeb `onShowFileSelector` 与 Core File Kit 多文件选择。
2. 系统分享 Want 中的多 URI 解析（单文件分享已实现）。
3. 下载流写入应用沙箱，再通过 SaveButton/文档选择器保存到用户指定位置。
4. Push Kit 或本地通知显示任务完成/失败。
5. 分享与下载仍需真机覆盖不同来源应用进行验证。

## 打开方式

1. 安装最新版 DevEco Studio 并下载 HarmonyOS NEXT SDK。
2. 选择 **Open Project**，打开本目录。
3. 让 DevEco 自动同步 hvigor 与 SDK。
4. 在 `build-profile.json5` 配置自动签名。
5. 使用真机或模拟器运行 `entry`。

## 安全边界

- 只允许 HTTPS 服务地址。
- 不在客户端保存服务器运维密钥、Codex 登录文件或 API Key。
- 登录 Cookie 由 ArkWeb 管理。
- 原生分享文件后续必须通过临时 URI 映射，不允许网页读取任意本机路径。
