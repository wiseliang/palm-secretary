package cloud.wiseliang.palmsecretary.quizassistant.accessibility;

import android.accessibilityservice.AccessibilityService;
import android.content.res.Configuration;
import android.os.SystemClock;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.util.Log;
import android.content.Intent;
import android.webkit.CookieManager;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;

import cloud.wiseliang.palmsecretary.BuildConfig;
import cloud.wiseliang.palmsecretary.MainActivity;
import cloud.wiseliang.palmsecretary.quizassistant.QuizAssistantCoordinator;
import cloud.wiseliang.palmsecretary.quizassistant.overlay.QuizOverlayController;
import cloud.wiseliang.palmsecretary.quizassistant.model.QuizAnalysisRequest;
import cloud.wiseliang.palmsecretary.quizassistant.model.QuizAnalysisResult;
import cloud.wiseliang.palmsecretary.quizassistant.model.QuizQuestionPreview;
import cloud.wiseliang.palmsecretary.quizassistant.network.QuizApiClient;
import cloud.wiseliang.palmsecretary.quizassistant.QuizAssistantPreferences;
import cloud.wiseliang.palmsecretary.quizassistant.capture.CropPlan;
import cloud.wiseliang.palmsecretary.quizassistant.capture.QuizImageProcessor;
import cloud.wiseliang.palmsecretary.quizassistant.capture.ScreenCaptureCoordinator;
import cloud.wiseliang.palmsecretary.quizassistant.capture.VisionFallbackDecider;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.UUID;

public final class QuizAssistantAccessibilityService extends AccessibilityService {
    private static final String TAG = "PalmQuizService";

    private QuizOverlayController overlayController;
    private String foregroundPackage;
    private final ExecutorService networkExecutor = Executors.newSingleThreadExecutor();
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private boolean requestInProgress;
    private String activeRequestId;
    private ScreenCaptureCoordinator captureCoordinator;
    private QuizImageProcessor.EncodedImage pendingVisionImage;

    @Override
    protected void onServiceConnected() {
        super.onServiceConnected();
        overlayController = new QuizOverlayController(this, this::captureQuestionOnce, this::ignoreActiveResult);
        captureCoordinator = new ScreenCaptureCoordinator(this, overlayController);
        QuizAssistantCoordinator.attach(this);
        debug("connected");
        refreshOverlayState();
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        if (event == null
                || event.getEventType() != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED
                || event.getPackageName() == null) {
            return;
        }
        String eventPackage = event.getPackageName().toString();
        CharSequence eventClass = event.getClassName();
        if (isCurrentInputMethod(eventPackage)) return;
        if (captureCoordinator != null && captureCoordinator.isInProgress() && getPackageName().equals(eventPackage)) return;
        if (getPackageName().equals(eventPackage)
                && (eventClass == null || !eventClass.toString().startsWith(getPackageName()))) {
            return;
        }
        foregroundPackage = eventPackage;
        debug("foreground package=" + foregroundPackage);
        refreshOverlayState();
    }

    private boolean isCurrentInputMethod(String packageName) {
        String component = Settings.Secure.getString(getContentResolver(),
            Settings.Secure.DEFAULT_INPUT_METHOD);
        return component != null && component.startsWith(packageName + "/");
    }

    @Override
    public void onInterrupt() {
        debug("interrupted");
        hideAllOverlays();
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        if (overlayController != null) overlayController.onConfigurationChanged();
        refreshOverlayState();
    }

    @Override
    public void onDestroy() {
        debug("disconnected");
        hideAllOverlays();
        QuizAssistantCoordinator.detach(this);
        activeRequestId = null;
        requestInProgress = false;
        networkExecutor.shutdownNow();
        clearPendingImage();
        captureCoordinator = null;
        overlayController = null;
        super.onDestroy();
    }

    public void refreshOverlayState() {
        if (overlayController == null) return;
        boolean allowed = QuizAssistantCoordinator.isPackageAllowed(this, foregroundPackage);
        debug(allowed ? "whitelist hit; overlay show" : "whitelist miss; overlay hide");
        if (allowed) overlayController.showOverlay();
        else {
            activeRequestId = null;
            requestInProgress = false;
            clearPendingImage();
            overlayController.hideOverlay();
        }
    }

    private void hideAllOverlays() {
        if (overlayController != null) overlayController.destroy();
    }

    private void captureQuestionOnce() {
        if (requestInProgress || overlayController == null) return;
        if (!QuizAssistantCoordinator.isPackageAllowed(this, foregroundPackage)) {
            overlayController.hideOverlay();
            return;
        }
        requestInProgress = true;
        overlayController.showReading();
        long startedAt = SystemClock.elapsedRealtime();
        String clientRequestId = UUID.randomUUID().toString();
        boolean handedToNetwork = false;
        try {
            AccessibilityTreeReader reader = new AccessibilityTreeReader();
            AccessibilityNodeInfo safetyRoot = getRootInActiveWindow();
            if (safetyRoot == null) {
                overlayController.showFailed("暂时无法读取当前页面内容。", null);
                return;
            }
            if (reader.containsVisiblePassword(safetyRoot)) {
                overlayController.showSensitive();
                return;
            }
            long snapshotStartedAt = SystemClock.elapsedRealtime();
            AccessibilityNodeInfo root = getRootInActiveWindow();
            if (root == null) {
                overlayController.showFailed("暂时无法读取当前页面内容。", null);
                return;
            }
            AccessibilityTreeReader.Result tree = reader.readAndRecycle(root);
            long snapshotCompletedAt = SystemClock.elapsedRealtime();
            long snapshotMs = snapshotCompletedAt - snapshotStartedAt;
            long accessibilityMs = snapshotCompletedAt - startedAt;
            for (NodeSnapshot node : tree.nodes) {
                if (node.visibleToUser && node.password) {
                    overlayController.showSensitive();
                    return;
                }
            }
            if (!QuizAssistantCoordinator.isPackageAllowed(this, foregroundPackage)) {
                overlayController.hideOverlay();
                return;
            }
            long extractorStartedAt = SystemClock.elapsedRealtime();
            QuizQuestionPreview preview = new QuestionExtractor().extract(tree.nodes, tree.truncated);
            long extractorMs = SystemClock.elapsedRealtime() - extractorStartedAt;
            debug("tree captured: nodes=" + tree.nodes.size() + " textNodes="
                + tree.textNodeCount + " depth=" + tree.maxDepth + " truncated=" + tree.truncated
                + " snapshotMs=" + snapshotMs);
            debug("question extraction: options=" + preview.options.size()
                + " confidence=" + String.format(java.util.Locale.ROOT, "%.2f", preview.confidence)
                + " extractorMs=" + extractorMs + " totalMs="
                + (SystemClock.elapsedRealtime() - startedAt));
            debug("quiz local timing: requestId=" + clientRequestId + " accessibilityMs="
                + accessibilityMs + " extractionMs=" + extractorMs);
            VisionFallbackDecider.Decision decision = new VisionFallbackDecider().decide(preview, tree.nodes,
                new QuizAssistantPreferences(this).isVisionEnabled(), android.os.Build.VERSION.SDK_INT,
                true, false, true);
            if (decision.route == VisionFallbackDecider.Route.TEXT_ONLY) {
                startAnalysis(preview, true, startedAt, clientRequestId, accessibilityMs, extractorMs);
                handedToNetwork = true;
            } else if (decision.route == VisionFallbackDecider.Route.HYBRID
                    || decision.route == VisionFallbackDecider.Route.VISION_FALLBACK) {
                startVisionCapture(preview, tree, decision.route, startedAt, clientRequestId,
                    accessibilityMs, extractorMs);
                handedToNetwork = true;
            } else if (android.os.Build.VERSION.SDK_INT < 30 && preview.confidence < 0.75f) {
                overlayController.showFailed("当前 Android 版本暂不支持图像识别，可继续使用文字题解析。", tree);
            } else if (preview.confidence >= 0.45f) {
                requestInProgress = false;
                overlayController.showPartial(preview, tree,
                    () -> startAnalysis(preview, false, startedAt, clientRequestId, accessibilityMs, extractorMs));
            } else {
                overlayController.showLocalFailure(preview, tree);
            }
        } catch (RuntimeException error) {
            if (BuildConfig.DEBUG) Log.w(TAG, "manual capture failed", error);
            overlayController.showFailed("暂时无法读取当前页面内容。", null);
        } finally {
            if (!handedToNetwork) requestInProgress = false;
        }
    }

    private void startVisionCapture(QuizQuestionPreview preview, AccessibilityTreeReader.Result tree,
            VisionFallbackDecider.Route route, long startedAt, String requestId,
            long accessibilityMs, long extractionMs) {
        activeRequestId=requestId;
        captureCoordinator.capture(foregroundPackage,preview,tree,route,new ScreenCaptureCoordinator.Callback() {
            @Override public void onReady(QuizImageProcessor.EncodedImage image, CropPlan plan,
                    boolean needsConfirmation,long screenshotMs,long cropMs,long encodeMs) {
                if (!requestId.equals(activeRequestId) || !QuizAssistantCoordinator.isPackageAllowed(
                        QuizAssistantAccessibilityService.this,foregroundPackage)) { image.clear(); requestInProgress=false; return; }
                if (needsConfirmation) {
                    pendingVisionImage=image;
                    requestInProgress=false;
                    overlayController.showVisionConfirmation(
                        () -> { pendingVisionImage=null; startVisionAnalysis(preview,image,"vision",startedAt,
                            requestId,accessibilityMs,extractionMs,screenshotMs,cropMs,encodeMs); },
                        () -> { clearPendingImage(); activeRequestId=null; overlayController.showOverlay(); });
                } else startVisionAnalysis(preview,image,route==VisionFallbackDecider.Route.HYBRID?"hybrid":"vision",
                    startedAt,requestId,accessibilityMs,extractionMs,screenshotMs,cropMs,encodeMs);
            }
            @Override public void onFailure(String message) {
                requestInProgress=false;
                if (!requestId.equals(activeRequestId)) return;
                activeRequestId=null; overlayController.showOverlay(); overlayController.showError(message,"重试",
                    QuizAssistantAccessibilityService.this::captureQuestionOnce);
            }
        });
    }

    private void startVisionAnalysis(QuizQuestionPreview preview, QuizImageProcessor.EncodedImage image,
            String captureMode,long startedAt,String requestId,long accessibilityMs,long extractionMs,
            long screenshotMs,long cropMs,long encodeMs) {
        if (!requestId.equals(activeRequestId)
                || !QuizAssistantCoordinator.isPackageAllowed(this,foregroundPackage)) { image.clear(); return; }
        requestInProgress=true;
        QuizAnalysisRequest request=new QuizAnalysisRequest(requestId,foregroundPackage,preview);
        String cookie=CookieManager.getInstance().getCookie("https://ai.wiseliang.cloud/");
        overlayController.showOverlay(); overlayController.showAnalyzingImage();
        mainHandler.postDelayed(()->updateImageLoading(requestId,false),6_000);
        mainHandler.postDelayed(()->updateImageLoading(requestId,true),12_000);
        networkExecutor.execute(()->{
            try {
                QuizApiClient.Response response=new QuizApiClient().analyzeVision(request,captureMode,image.bytes,
                    image.mimeType,image.width,image.height,cookie);
                mainHandler.post(()->completeSuccess(requestId,preview,response,startedAt,accessibilityMs,extractionMs));
            } catch(QuizApiClient.ApiException error) { mainHandler.post(()->completeError(requestId,error)); }
            catch(RuntimeException error) { mainHandler.post(()->completeError(requestId,
                new QuizApiClient.ApiException(QuizApiClient.ErrorType.SERVER_ERROR,"服务器暂时不可用"))); }
            finally { image.clear(); }
        });
        debug("vision local timing: requestId="+requestId+" screenshotMs="+screenshotMs+" cropMs="+cropMs
            +" encodeMs="+encodeMs+" bytes="+image.bytes.length+" width="+image.width+" height="+image.height);
    }

    private void updateImageLoading(String requestId,boolean verySlow) {
        if(!requestInProgress||!requestId.equals(activeRequestId)||overlayController==null)return;
        if(verySlow) overlayController.showAnalyzingImageSlow(); else overlayController.showAnalyzingImage();
    }

    private void startAnalysis(QuizQuestionPreview preview, boolean alreadyReserved, long startedAt,
            String clientRequestId, long accessibilityMs, long extractionMs) {
        if (overlayController == null || (!alreadyReserved && requestInProgress)) return;
        if (!QuizAssistantCoordinator.isPackageAllowed(this, foregroundPackage)) {
            overlayController.hideOverlay();
            requestInProgress = false;
            return;
        }
        requestInProgress = true;
        QuizAnalysisRequest request = new QuizAnalysisRequest(clientRequestId, foregroundPackage, preview);
        activeRequestId = request.clientRequestId;
        String cookie = CookieManager.getInstance().getCookie("https://ai.wiseliang.cloud/");
        overlayController.showAnalyzing();
        mainHandler.postDelayed(() -> updateLoading(request.clientRequestId, false), 6_000);
        mainHandler.postDelayed(() -> updateLoading(request.clientRequestId, true), 12_000);
        networkExecutor.execute(() -> {
            try {
                long httpStartedAt = SystemClock.elapsedRealtime();
                debug("quiz HTTP started: requestId=" + request.clientRequestId);
                QuizApiClient.Response response = new QuizApiClient().analyze(request, cookie);
                mainHandler.post(() -> completeSuccess(request.clientRequestId, preview, response,
                    startedAt, accessibilityMs, extractionMs));
            } catch (QuizApiClient.ApiException error) {
                mainHandler.post(() -> completeError(request.clientRequestId, error));
            } catch (RuntimeException error) {
                mainHandler.post(() -> completeError(request.clientRequestId,
                    new QuizApiClient.ApiException(QuizApiClient.ErrorType.SERVER_ERROR, "服务器暂时不可用")));
            }
        });
    }

    private void updateLoading(String requestId, boolean verySlow) {
        if (!requestInProgress || !requestId.equals(activeRequestId) || overlayController == null) return;
        if (verySlow) overlayController.showAnalyzingVerySlow(); else overlayController.showAnalyzingSlow();
    }

    private void completeSuccess(String requestId, QuizQuestionPreview preview,
            QuizApiClient.Response response, long startedAt, long accessibilityMs, long extractionMs) {
        requestInProgress = false;
        if (!requestId.equals(activeRequestId)) return;
        long renderStarted = SystemClock.elapsedRealtime();
        if (overlayController != null && QuizAssistantCoordinator.isPackageAllowed(this, foregroundPackage)) {
            overlayController.showAnswer(response.result, preview);
        }
        long renderedAt = SystemClock.elapsedRealtime();
        activeRequestId = null;
        debug("quiz request completed: requestId=" + requestId + " accessibilityMs="
            + accessibilityMs + " extractionMs=" + extractionMs + " headersMs=" + response.headersMs
            + " bodyMs=" + response.bodyMs + " requestMs=" + response.requestMs + " parseMs="
            + response.parseMs + " renderMs=" + (renderedAt - renderStarted) + " totalMs="
            + (renderedAt - startedAt));
    }

    private void completeError(String requestId, QuizApiClient.ApiException error) {
        requestInProgress = false;
        if (!requestId.equals(activeRequestId)) return;
        activeRequestId = null;
        debug("quiz request failed: type=" + error.type.name());
        if (overlayController == null || !QuizAssistantCoordinator.isPackageAllowed(this, foregroundPackage)) return;
        if (error.type == QuizApiClient.ErrorType.NO_SESSION) {
            overlayController.showError("掌心助理登录已过期", "打开掌心助理登录", this::openLogin);
            return;
        }
        overlayController.showError(error.getMessage(), "重试", this::captureQuestionOnce);
    }

    private void ignoreActiveResult() { activeRequestId = null; requestInProgress=false; clearPendingImage(); }

    private void clearPendingImage() {
        if(pendingVisionImage!=null) { pendingVisionImage.clear(); pendingVisionImage=null; }
    }

    private void openLogin() {
        Intent intent = new Intent(this, MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        startActivity(intent);
    }

    private static void debug(String message) {
        if (BuildConfig.DEBUG) Log.d(TAG, message);
    }
}
