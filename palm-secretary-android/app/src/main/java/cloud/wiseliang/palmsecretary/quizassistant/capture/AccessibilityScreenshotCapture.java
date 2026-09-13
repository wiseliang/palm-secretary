package cloud.wiseliang.palmsecretary.quizassistant.capture;

import android.accessibilityservice.AccessibilityService;
import android.os.Build;
import android.view.Display;

public final class AccessibilityScreenshotCapture {
    public interface Callback {
        void onSuccess(AccessibilityService.ScreenshotResult result);
        void onFailure(int errorCode);
    }

    private final AccessibilityService service;
    public AccessibilityScreenshotCapture(AccessibilityService service) { this.service=service; }

    public void capture(int windowId, Callback callback) {
        if (Build.VERSION.SDK_INT < 30) { callback.onFailure(2); return; }
        AccessibilityService.TakeScreenshotCallback bridge=new AccessibilityService.TakeScreenshotCallback() {
            @Override public void onSuccess(AccessibilityService.ScreenshotResult result) { callback.onSuccess(result); }
            @Override public void onFailure(int errorCode) { callback.onFailure(errorCode); }
        };
        if (Build.VERSION.SDK_INT >= 34) service.takeScreenshotOfWindow(windowId,service.getMainExecutor(),bridge);
        else service.takeScreenshot(Display.DEFAULT_DISPLAY,service.getMainExecutor(),bridge);
    }

    public static String userMessage(int code) {
        if (code==6) return "当前应用禁止截屏，无法进行图片识别。";
        if (code==3) return "截图操作过于频繁，请稍后重试。";
        if (code==2) return "无障碍截图权限不可用。";
        return "无法获取当前题目画面。";
    }
}
