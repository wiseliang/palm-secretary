package cloud.wiseliang.palmsecretary.quizassistant.overlay;

import android.content.Context;
import android.os.Build;
import android.hardware.display.DisplayManager;
import android.view.Display;
import android.view.WindowManager;

import cloud.wiseliang.palmsecretary.quizassistant.accessibility.AccessibilityTreeReader;
import cloud.wiseliang.palmsecretary.quizassistant.model.QuizQuestionPreview;
import cloud.wiseliang.palmsecretary.quizassistant.model.QuizAnalysisResult;

public final class QuizOverlayController {
    private final FloatingBallController floatingBall;
    private final AnswerCardController answerCard;

    public QuizOverlayController(Context context, Runnable manualCapture, Runnable dismissed) {
        // Bind both overlays to a fresh accessibility window context for this connection.
        // A service's cached WindowManager can retain an invalid token after rebinding.
        Context overlayContext = Build.VERSION.SDK_INT >= 30
            ? context.createWindowContext(((DisplayManager) context.getSystemService(Context.DISPLAY_SERVICE))
                .getDisplay(Display.DEFAULT_DISPLAY), WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY, null)
            : context;
        WindowManager windowManager = (WindowManager) overlayContext.getSystemService(Context.WINDOW_SERVICE);
        answerCard = new AnswerCardController(overlayContext, windowManager, manualCapture, dismissed);
        floatingBall = new FloatingBallController(overlayContext, windowManager, manualCapture::run);
    }

    public void showOverlay() {
        floatingBall.show();
    }

    public void hideOverlay() {
        answerCard.hide();
        floatingBall.hide();
    }

    public void showReading() { answerCard.showReading(); }
    public void showAnalyzing() { answerCard.showAnalyzing(); }
    public void showAnalyzingSlow() { answerCard.showAnalyzingSlow(); }
    public void showAnalyzingVerySlow() { answerCard.showAnalyzingVerySlow(); }
    public void showCapturing() { answerCard.showCapturing(); }
    public void showRecognizingText() { answerCard.showRecognizingText(); }
    public void showAnalyzingImage() { answerCard.showAnalyzingImage(); }
    public void showAnalyzingImageSlow() { answerCard.showAnalyzingImageSlow(); }
    public void hideForCapture() { answerCard.hide(); floatingBall.hide(); }
    public void showVisionConfirmation(Runnable confirm, Runnable cancel) {
        floatingBall.show(); answerCard.showVisionConfirmation(confirm,cancel);
    }

    public void showFailed(String message, AccessibilityTreeReader.Result tree) {
        answerCard.showFailed(message, tree);
    }

    public void showSensitive() { answerCard.showSensitive(); }

    public void showPartial(QuizQuestionPreview preview, AccessibilityTreeReader.Result tree, Runnable analyze) {
        answerCard.showPartial(preview, tree, analyze);
    }

    public void showLocalFailure(QuizQuestionPreview preview, AccessibilityTreeReader.Result tree) {
        answerCard.showLocalFailure(preview, tree);
    }

    public void showAnswer(QuizAnalysisResult result, QuizQuestionPreview preview) {
        answerCard.showAnswer(result, preview);
    }

    public void showError(String message, String actionLabel, Runnable action) {
        answerCard.showError(message, actionLabel, action);
    }

    public void onConfigurationChanged() {
        floatingBall.reposition();
        answerCard.reposition();
    }

    public void destroy() {
        hideOverlay();
    }
}
