# 掌心助理 Android

掌心助理现有公网服务的轻量 Android 客户端。App 只访问 `https://ai.wiseliang.cloud`，不包含服务器管理或 root 权限。

首版支持：

- 密码登录与会话保持
- Codex 实时对话与任务停止
- 项目、历史会话、模型和推理强度切换
- 手机文件选择与上传
- 成果文件下载到系统“下载”目录
- WebSocket 自动重连、返回键导航、断网提示

安全边界：

- 仅允许 `ai.wiseliang.cloud` 在 App 内打开；其他链接交给系统浏览器
- 禁止明文 HTTP、混合内容、忽略 TLS 错误和 WebView 调试
- 密码与 Cookie 不写入源码，登录 Cookie 位于 Android App 沙箱

构建：使用 JDK 17 和 Android SDK 35，运行 `gradlew.bat assembleDebug`。
