package cloud.wiseliang.palmsecretary.quizassistant.overlay;

import android.content.Context;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.os.Build;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.util.List;
import java.util.Locale;

import cloud.wiseliang.palmsecretary.BuildConfig;
import cloud.wiseliang.palmsecretary.R;
import cloud.wiseliang.palmsecretary.quizassistant.accessibility.AccessibilityTreeReader;
import cloud.wiseliang.palmsecretary.quizassistant.model.QuizAnalysisResult;
import cloud.wiseliang.palmsecretary.quizassistant.model.QuizOptionAnalysis;
import cloud.wiseliang.palmsecretary.quizassistant.model.QuizOptionPreview;
import cloud.wiseliang.palmsecretary.quizassistant.model.QuizQuestionPreview;

final class AnswerCardController {
    private final Context context;
    private final WindowManager windowManager;
    private final Runnable retry;
    private final Runnable dismissed;
    private LinearLayout view;
    private TextView title, body, details, debugSummary, contextNotice;
    private ScrollView detailsScroll;
    private Button primary, secondary;
    private WindowManager.LayoutParams params;
    private boolean attached;

    AnswerCardController(Context context, WindowManager windowManager, Runnable retry, Runnable dismissed) {
        this.context = context;
        this.windowManager = windowManager;
        this.retry = retry;
        this.dismissed = dismissed;
    }

    void showReading() { prepare("正在读取题目", "正在进行一次本地节点读取…", "", null); }
    void showAnalyzing() { prepare("正在解析", "正在安全发送已识别的纯文字题目…", "", null); }
    void showAnalyzingSlow() { prepare("正在解析", "题目已识别，AI 正在生成解析…", "", null); }
    void showAnalyzingVerySlow() { prepare("正在解析", "这道题解析时间较长…", "", null); }
    void showCapturing() { prepare("正在读取题目画面", "仅处理当前应用中的题目区域…", "", null); }
    void showRecognizingText() { prepare("正在识别题目文字", "正在本地识别题目文字…", "", null); }
    void showAnalyzingImage() { prepare("正在识别图片题", "AI 正在分析题目画面…", "", null); }
    void showAnalyzingImageSlow() { prepare("正在识别图片题", "图片题解析时间较长…", "", null); }
    void showSensitive() { prepare("已停止读取", "当前页面包含敏感内容，刷题助手不会读取。", "", null); }

    void showFailed(String message, AccessibilityTreeReader.Result tree) {
        prepare("未能可靠识别当前题目", message, "", tree);
        action(primary, "重试", retry);
    }

    void showPartial(QuizQuestionPreview preview, AccessibilityTreeReader.Result tree, Runnable analyze) {
        prepare("识别结果可能不完整", previewSummary(preview), previewDetails(preview), tree);
        action(primary, "仍然解析", analyze);
        toggleAction(secondary, "查看识别结果", "收起识别结果");
    }

    void showLocalFailure(QuizQuestionPreview preview, AccessibilityTreeReader.Result tree) {
        prepare("未能可靠识别当前题目", previewSummary(preview), previewDetails(preview), tree);
        action(primary, "重试", retry);
        toggleAction(secondary, "查看读取结果", "收起读取结果");
    }

    void showAnswer(QuizAnalysisResult result, QuizQuestionPreview preview) {
        String answer = displayAnswer(result, preview);
        String uncertainty = result.confidence < 0.55 ? "\n答案存在不确定性" : "";
        prepare("答案  " + answer, result.shortExplanation + uncertainty, answerDetails(result, preview), null);
        contextNotice.setVisibility(View.VISIBLE);
        toggleAction(primary, "查看详细解析", "收起详细解析");
    }

    void showError(String message, String actionLabel, Runnable action) {
        prepare("解析未完成", message, "", null);
        if (action != null && actionLabel != null) action(primary, actionLabel, action);
    }

    void showVisionConfirmation(Runnable confirm, Runnable cancel) {
        prepare("确认视觉识别", "无法准确定位题目区域。是否使用当前应用画面进行视觉识别？", "", null);
        action(primary,"视觉识别",confirm);
        action(secondary,"取消",cancel);
    }

    void hide() {
        if (!attached || view == null) return;
        try { windowManager.removeViewImmediate(view); }
        catch (RuntimeException ignored) { }
        finally { attached = false; }
    }

    void reposition() {
        if (view == null) return;
        position();
        if (!attached) return;
        try { windowManager.updateViewLayout(view, params); }
        catch (RuntimeException ignored) { attached = false; }
    }

    private void prepare(String heading, String message, String expanded, AccessibilityTreeReader.Result tree) {
        if (view == null) createView();
        title.setText(heading);
        body.setText(message);
        body.setMaxLines(4);
        details.setText(expanded);
        detailsScroll.setVisibility(View.GONE);
        primary.setVisibility(View.GONE);
        secondary.setVisibility(View.GONE);
        contextNotice.setVisibility(View.GONE);
        if (BuildConfig.DEBUG && tree != null) {
            debugSummary.setText(nodeSummary(tree));
            debugSummary.setVisibility(View.VISIBLE);
        } else debugSummary.setVisibility(View.GONE);
        ensureShown();
        update();
    }

    private void createView() {
        view = new LinearLayout(context);
        view.setOrientation(LinearLayout.VERTICAL);
        view.setPadding(dp(18), dp(17), dp(18), dp(16));
        view.setBackgroundResource(R.drawable.quiz_card_background);
        view.setElevation(dp(16));
        contextNotice = text(11, R.color.palm_quiz_muted, false);
        contextNotice.setText("基于点击时读取的题目");
        view.addView(contextNotice, new LinearLayout.LayoutParams(-1, -2));
        title = text(17, R.color.palm_quiz_ink, true); addWithTopMargin(title, 4);
        body = text(14, R.color.palm_quiz_muted, false); addWithTopMargin(body, 8);
        details = text(13, R.color.palm_quiz_ink, false);
        detailsScroll = new ScrollView(context);
        detailsScroll.setFillViewport(false);
        detailsScroll.addView(details, new ScrollView.LayoutParams(-1, -2));
        LinearLayout.LayoutParams scrollParams = new LinearLayout.LayoutParams(-1, dp(300));
        scrollParams.topMargin = dp(12);
        view.addView(detailsScroll, scrollParams);
        debugSummary = text(11, R.color.palm_quiz_muted, false); addWithTopMargin(debugSummary, 10);
        primary = button(); addWithTopMargin(primary, 12);
        secondary = button(); addWithTopMargin(secondary, 8);
        Button close = button();
        close.setText(R.string.close);
        close.setOnClickListener(ignored -> { dismissed.run(); hide(); });
        addWithTopMargin(close, 8);
        params = new WindowManager.LayoutParams(1, WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
            PixelFormat.TRANSLUCENT);
        params.gravity = Gravity.TOP | Gravity.START;
    }

    private void action(Button button, String label, Runnable action) {
        button.setText(label); button.setVisibility(View.VISIBLE);
        button.setOnClickListener(ignored -> action.run());
    }

    private void toggleAction(Button button, String closed, String open) {
        button.setText(closed); button.setVisibility(View.VISIBLE);
        button.setOnClickListener(ignored -> {
            boolean showing = detailsScroll.getVisibility() != View.VISIBLE;
            detailsScroll.setVisibility(showing ? View.VISIBLE : View.GONE);
            button.setText(showing ? open : closed); update();
        });
    }

    private TextView text(int size, int color, boolean bold) {
        TextView value = new TextView(context);
        value.setTextSize(size); value.setTextColor(context.getColor(color)); value.setLineSpacing(dp(2), 1f);
        if (bold) value.setTypeface(value.getTypeface(), android.graphics.Typeface.BOLD);
        return value;
    }

    private Button button() {
        Button value = new Button(context);
        value.setTextColor(context.getColor(R.color.palm_white)); value.setTextSize(14);
        value.setAllCaps(false); value.setBackgroundResource(R.drawable.quiz_primary_button_background);
        return value;
    }

    private void addWithTopMargin(View child, int marginDp) {
        LinearLayout.LayoutParams childParams = new LinearLayout.LayoutParams(-1, child instanceof Button ? dp(42) : -2);
        childParams.topMargin = dp(marginDp); view.addView(child, childParams);
    }

    private void ensureShown() {
        if (attached) return; position();
        try { windowManager.addView(view, params); attached = true; }
        catch (RuntimeException ignored) { attached = false; }
    }

    private void update() {
        if (!attached) return; position();
        try { windowManager.updateViewLayout(view, params); }
        catch (RuntimeException ignored) { attached = false; }
    }

    private void position() {
        Rect bounds = screenBounds(); params.width = Math.min(dp(340), bounds.width() - dp(24));
        if (detailsScroll != null) {
            LinearLayout.LayoutParams detailParams = (LinearLayout.LayoutParams) detailsScroll.getLayoutParams();
            detailParams.height = Math.max(dp(120), Math.min(dp(300), bounds.height() - dp(390)));
            detailsScroll.setLayoutParams(detailParams);
        }
        params.x = bounds.left + Math.max(0, (bounds.width() - params.width) / 2); params.y = dp(64);
    }

    private Rect screenBounds() {
        if (Build.VERSION.SDK_INT >= 30) {
            Rect bounds = new Rect(windowManager.getCurrentWindowMetrics().getBounds());
            WindowInsets insets = windowManager.getCurrentWindowMetrics().getWindowInsets();
            android.graphics.Insets bars = insets.getInsetsIgnoringVisibility(
                WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars() | WindowInsets.Type.displayCutout());
            bounds.left += bars.left; bounds.right -= bars.right; return bounds;
        }
        android.util.DisplayMetrics metrics = new android.util.DisplayMetrics();
        windowManager.getDefaultDisplay().getRealMetrics(metrics);
        return new Rect(0, 0, metrics.widthPixels, metrics.heightPixels);
    }

    private static String previewSummary(QuizQuestionPreview preview) {
        String question = preview.questionText.isEmpty() ? "未找到可靠题干" : preview.questionText;
        return question + (preview.options.isEmpty() ? "" : "\n" + optionIds(preview) + " 共 " + preview.options.size() + " 个选项");
    }

    private static String previewDetails(QuizQuestionPreview preview) {
        StringBuilder value = new StringBuilder("题干\n").append(preview.questionText).append("\n\n选项\n");
        for (QuizOptionPreview option : preview.options) value.append(option.optionId).append(". ").append(option.text).append('\n');
        return value.append("\n题型\n").append(typeLabel(preview.questionType)).append("\n\n识别完整度\n")
            .append(Math.round(preview.confidence * 100)).append('%').toString();
    }

    private static String answerDetails(QuizAnalysisResult result, QuizQuestionPreview preview) {
        StringBuilder value = new StringBuilder("正确答案\n").append(displayAnswer(result, preview))
            .append("\n\n核心解析\n").append(result.shortExplanation)
            .append("\n\n完整解析\n").append(result.fullExplanation).append("\n\n选项分析\n");
        for (QuizOptionAnalysis option : result.optionAnalysis) value.append(option.optionId).append(" · ")
            .append(verdictLabel(option.verdict)).append('\n').append(option.explanation).append("\n\n");
        if (!result.knowledgePoints.isEmpty()) value.append("知识点\n• ").append(join(result.knowledgePoints, "\n• ")).append("\n\n");
        if (!result.memoryTip.isEmpty()) value.append("记忆提示\n").append(result.memoryTip).append("\n\n");
        if (!result.warnings.isEmpty()) value.append("注意\n• ").append(join(result.warnings, "\n• "));
        return value.toString().trim();
    }

    private static String displayAnswer(QuizAnalysisResult result, QuizQuestionPreview preview) {
        if (!"true_false".equals(result.questionType)) return join(result.answer, "、");
        java.util.ArrayList<String> labels = new java.util.ArrayList<>();
        for (String answer : result.answer) {
            String label = answer;
            for (QuizOptionPreview option : preview.options) {
                if (option.optionId.equalsIgnoreCase(answer)) { label = option.text; break; }
            }
            labels.add(label);
        }
        return join(labels, "、");
    }

    private static String verdictLabel(String verdict) {
        if ("correct".equals(verdict)) return "正确";
        if ("incorrect".equals(verdict)) return "错误";
        if ("partially_correct".equals(verdict)) return "部分正确";
        return "不确定";
    }

    private static String join(List<String> values, String separator) {
        StringBuilder result = new StringBuilder();
        for (String value : values) { if (result.length() > 0) result.append(separator); result.append(value); }
        return result.toString();
    }

    private static String optionIds(QuizQuestionPreview preview) {
        StringBuilder value = new StringBuilder();
        for (QuizOptionPreview option : preview.options) { if (value.length() > 0) value.append(" / "); value.append(option.optionId); }
        return value.toString();
    }

    private static String typeLabel(QuizQuestionPreview.QuestionType type) {
        switch (type) { case SINGLE_CHOICE: return "单选题"; case MULTIPLE_CHOICE: return "多选题"; case TRUE_FALSE: return "判断题"; default: return "未知"; }
    }

    private static String nodeSummary(AccessibilityTreeReader.Result tree) {
        return String.format(Locale.ROOT, "节点摘要（仅 Debug）\n节点 %d · 文本 %d · 可点击 %d\nRadioButton %d · CheckBox %d · WebView %d\n最大深度 %d · truncated=%s",
            tree.nodes.size(), tree.textNodeCount, tree.clickableCount, tree.radioButtonCount,
            tree.checkBoxCount, tree.webViewCount, tree.maxDepth, tree.truncated);
    }

    private int dp(int value) { return Math.round(value * context.getResources().getDisplayMetrics().density); }
}
