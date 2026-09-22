package cloud.wiseliang.palmsecretary.quizassistant.capture;

import java.util.List;
import java.util.Locale;

import cloud.wiseliang.palmsecretary.quizassistant.accessibility.NodeSnapshot;
import cloud.wiseliang.palmsecretary.quizassistant.model.QuizQuestionPreview;

public final class VisionFallbackDecider {
    public enum Route { TEXT_ONLY, HYBRID, VISION_FALLBACK, DENIED }
    public static final class Decision {
        public final Route route;
        public final String reason;
        Decision(Route route, String reason) { this.route = route; this.reason = reason; }
    }

    private static final String[] VISUAL_WORDS = {"如图", "图中", "下图", "上图", "图示", "示意图",
        "流程图", "曲线", "图表", "图片", "图像", "根据图", "结合图", "设备图", "看图"};

    public Decision decide(QuizQuestionPreview preview, List<NodeSnapshot> nodes,
            boolean visionEnabled, int sdkInt, boolean allowed, boolean sensitive,
            boolean currentWindowMatches) {
        if (!allowed || sensitive || !currentWindowMatches) return new Decision(Route.DENIED, "安全状态不允许截图");
        boolean visual = hasVisualCue(preview, nodes);
        if (preview.complete && !visual) return new Decision(Route.TEXT_ONLY, "文字题完整且无视觉依赖");
        if (!visionEnabled) return new Decision(Route.DENIED, "未允许图像题识别");
        if (sdkInt < 30) return new Decision(Route.DENIED, "Android 版本低于 11");
        if (visual && !preview.questionText.isEmpty() && preview.options.size() >= 2) {
            return new Decision(Route.HYBRID, "题目包含视觉提示");
        }
        return new Decision(Route.VISION_FALLBACK, "文字识别不完整");
    }

    public boolean hasVisualCue(QuizQuestionPreview preview, List<NodeSnapshot> nodes) {
        String question = preview.questionText.toLowerCase(Locale.ROOT);
        for (String word : VISUAL_WORDS) if (question.contains(word)) return true;
        for (NodeSnapshot node : nodes) {
            String name = node.className.toLowerCase(Locale.ROOT);
            int width = Math.max(0, node.boundsInScreen.right - node.boundsInScreen.left);
            int height = Math.max(0, node.boundsInScreen.bottom - node.boundsInScreen.top);
            if (node.visibleToUser && (name.endsWith("imageview") || name.contains("image"))
                    && width >= 180 && height >= 120) return true;
        }
        return false;
    }
}
