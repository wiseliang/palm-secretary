# Android 0.13.10

- 修复无障碍配置订阅窗口变化，但处理函数忽略该事件的问题。
- 启用交互窗口获取，服务连接和窗口/页面变化后重新确认前台应用。
- 忽略键盘及自身悬浮窗口的干扰；只在已授权应用显示悬浮球。
- 截图过程中不因窗口变化重新显示悬浮球。
- 设置页面区分无障碍开关已开启与服务实际连接，未连接时提示重新启用。

安装新版后，在 Android 无障碍设置中关闭再开启“掌心助理刷题助手”，使新的事件配置生效。已授权应用及设置保留。

本版本使用本机 Android debug 签名构建内测 APK。已验证该签名与 GitHub android-v0.13.8 不同；尚未验证用户手机上 0.13.9 的签名。若覆盖安装提示签名冲突，请勿卸载旧版，以免丢失本地设置。代码和构建验证不能替代考试宝实机验收。

交互窗口标志要求参考 [Android 官方文档](https://developer.android.com/reference/android/accessibilityservice/AccessibilityServiceInfo#FLAG_RETRIEVE_INTERACTIVE_WINDOWS)。
