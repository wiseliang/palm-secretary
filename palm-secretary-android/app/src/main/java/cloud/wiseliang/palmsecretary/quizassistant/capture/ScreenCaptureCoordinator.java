package cloud.wiseliang.palmsecretary.quizassistant.capture;

import android.accessibilityservice.AccessibilityService;
import android.graphics.Bitmap;
import android.graphics.Rect;
import android.hardware.HardwareBuffer;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.Choreographer;
import android.view.accessibility.AccessibilityNodeInfo;

import cloud.wiseliang.palmsecretary.quizassistant.QuizAssistantCoordinator;
import cloud.wiseliang.palmsecretary.quizassistant.QuizAssistantPreferences;
import cloud.wiseliang.palmsecretary.BuildConfig;
import cloud.wiseliang.palmsecretary.quizassistant.accessibility.AccessibilityTreeReader;
import cloud.wiseliang.palmsecretary.quizassistant.model.QuizQuestionPreview;
import cloud.wiseliang.palmsecretary.quizassistant.overlay.QuizOverlayController;

public final class ScreenCaptureCoordinator {
    private static final String TAG = "PalmQuizCapture";
    public interface Callback {
        void onReady(QuizImageProcessor.EncodedImage image, CropPlan plan, boolean needsConfirmation,
            long screenshotMs, long cropMs, long encodeMs);
        void onFailure(String message);
    }

    private final AccessibilityService service;
    private final QuizAssistantPreferences preferences;
    private final QuizOverlayController overlay;
    private final AccessibilityScreenshotCapture capture;
    private final Handler mainHandler=new Handler(Looper.getMainLooper());
    private boolean inProgress;

    public ScreenCaptureCoordinator(AccessibilityService service, QuizOverlayController overlay) {
        this.service=service; this.overlay=overlay;
        preferences=new QuizAssistantPreferences(service);
        capture=new AccessibilityScreenshotCapture(service);
    }

    public boolean isInProgress() { return inProgress; }

    public void capture(String expectedPackage, QuizQuestionPreview preview,
            AccessibilityTreeReader.Result tree, VisionFallbackDecider.Route route, Callback callback) {
        if (inProgress) { callback.onFailure("截图操作过于频繁，请稍后重试。"); return; }
        if (Build.VERSION.SDK_INT<30) { callback.onFailure("当前 Android 版本暂不支持图像识别，可继续使用文字题解析。"); return; }
        if (!preferences.isVisionEnabled() || !QuizAssistantCoordinator.isPackageAllowed(service,expectedPackage)
                || service.getPackageName().equals(expectedPackage)) { callback.onFailure("当前页面不允许图像识别。"); return; }
        AccessibilityNodeInfo root=service.getRootInActiveWindow();
        if (root==null) { callback.onFailure("无法获取当前题目画面。"); return; }
        int windowId;
        Rect windowBounds=new Rect();
        try {
            if (root.getPackageName()==null || !expectedPackage.contentEquals(root.getPackageName())) {
                callback.onFailure("页面已变化，请重新点击悬浮球。"); return;
            }
            windowId=root.getWindowId(); root.getBoundsInScreen(windowBounds);
        } finally { recycle(root); }
        AccessibilityNodeInfo safetyRoot=service.getRootInActiveWindow();
        if (safetyRoot==null || new AccessibilityTreeReader().containsVisiblePassword(safetyRoot)) {
            callback.onFailure("当前页面包含敏感内容，刷题助手不会截图。"); return;
        }
        CropPlan appWindow=new CropPlan(windowBounds.left,windowBounds.top,windowBounds.right,windowBounds.bottom,
            0.25f,CropPlan.Source.APP_WINDOW);
        CropPlan plan=new QuizCropPlanner().plan(preview,tree.nodes,
            route==VisionFallbackDecider.Route.HYBRID,Math.round(32*service.getResources().getDisplayMetrics().density),appWindow);
        inProgress=true;
        overlay.showCapturing();
        Runnable start=()->doCapture(windowId,windowBounds,plan,callback);
        if (Build.VERSION.SDK_INT>=34) start.run();
        else {
            overlay.hideForCapture();
            Choreographer.getInstance().postFrameCallback(frameTimeNanos -> mainHandler.post(start));
        }
    }

    private void doCapture(int windowId, Rect windowBounds, CropPlan plan, Callback callback) {
        long started=android.os.SystemClock.elapsedRealtime();
        capture.capture(windowId,new AccessibilityScreenshotCapture.Callback() {
            @Override public void onSuccess(AccessibilityService.ScreenshotResult result) {
                long screenshotMs=android.os.SystemClock.elapsedRealtime()-started;
                HardwareBuffer buffer=result.getHardwareBuffer();
                Bitmap hardware=null,software=null;
                try {
                    hardware=Bitmap.wrapHardwareBuffer(buffer,result.getColorSpace());
                    if (hardware==null) throw new IllegalStateException("wrap failed");
                    software=hardware.copy(Bitmap.Config.ARGB_8888,false);
                } catch (RuntimeException error) {
                    if (BuildConfig.DEBUG) Log.w(TAG, "hardware buffer conversion failed", error);
                    finishFailure(callback,"无法处理当前题目画面。"); return;
                } finally {
                    buffer.close();
                    if (hardware!=null && !hardware.isRecycled()) hardware.recycle();
                }
                if (software==null) { finishFailure(callback,"无法获取当前题目画面。"); return; }
                try {
                    int originX=Build.VERSION.SDK_INT>=34?windowBounds.left:0;
                    int originY=Build.VERSION.SDK_INT>=34?windowBounds.top:0;
                    CropPlan effectivePlan=plan;
                    if (Build.VERSION.SDK_INT>=34 && plan.source==CropPlan.Source.APP_WINDOW) {
                        // takeScreenshotOfWindow already returns only the target app window. Some OEMs
                        // report Accessibility window bounds in display coordinates that do not map
                        // exactly to the returned buffer, so use the complete window buffer here.
                        effectivePlan=new CropPlan(0,0,software.getWidth(),software.getHeight(),
                            plan.confidence,CropPlan.Source.APP_WINDOW);
                        originX=0;
                        originY=0;
                    }
                    QuizImageProcessor.EncodedImage encoded=new QuizImageProcessor().process(
                        software,effectivePlan,originX,originY);
                    inProgress=false;
                    callback.onReady(encoded,effectivePlan,!effectivePlan.reliable(),screenshotMs,encoded.cropMs,encoded.encodeMs);
                } catch (RuntimeException error) {
                    if (BuildConfig.DEBUG) Log.w(TAG, "bitmap crop or encode failed", error);
                    finishFailure(callback,error.getMessage()!=null&&error.getMessage().contains("large")
                        ?"题目画面过大，无法上传解析。":"无法处理当前题目画面。");
                }
                finally { software.recycle(); }
            }
            @Override public void onFailure(int errorCode) { finishFailure(callback,AccessibilityScreenshotCapture.userMessage(errorCode)); }
        });
    }

    private void finishFailure(Callback callback,String message) { inProgress=false; callback.onFailure(message); }

    @SuppressWarnings("deprecation") private static void recycle(AccessibilityNodeInfo node) { node.recycle(); }
}
