package cloud.wiseliang.palmsecretary.quizassistant.capture;

import java.util.HashSet;
import java.util.List;
import java.util.Set;

import cloud.wiseliang.palmsecretary.quizassistant.accessibility.NodeSnapshot;
import cloud.wiseliang.palmsecretary.quizassistant.model.QuizOptionPreview;
import cloud.wiseliang.palmsecretary.quizassistant.model.QuizQuestionPreview;

public final class QuizCropPlanner {
    public CropPlan plan(QuizQuestionPreview preview, List<NodeSnapshot> nodes,
            boolean includeVisual, int marginPx, CropPlan appWindow) {
        if (!preview.complete && preview.options.size() < 2) return appWindow;
        Set<String> targets = new HashSet<>();
        if (!preview.questionText.isEmpty()) targets.add(preview.questionText);
        for (QuizOptionPreview option : preview.options) targets.add(option.text);
        int left=Integer.MAX_VALUE,top=Integer.MAX_VALUE,right=Integer.MIN_VALUE,bottom=Integer.MIN_VALUE;
        boolean matched=false, visual=false;
        for (NodeSnapshot node : nodes) {
            boolean textMatch = targets.contains(node.displayText());
            String className = node.className.toLowerCase(java.util.Locale.ROOT);
            int width=Math.max(0,node.boundsInScreen.right-node.boundsInScreen.left);
            int height=Math.max(0,node.boundsInScreen.bottom-node.boundsInScreen.top);
            boolean image = includeVisual && node.visibleToUser && (className.endsWith("imageview") || className.contains("image"))
                && width>=180 && height>=120;
            if (!textMatch && !image) continue;
            matched |= textMatch; visual |= image;
            left=Math.min(left,node.boundsInScreen.left); top=Math.min(top,node.boundsInScreen.top);
            right=Math.max(right,node.boundsInScreen.right); bottom=Math.max(bottom,node.boundsInScreen.bottom);
        }
        if (!matched || right<=left || bottom<=top) return appWindow;
        if (includeVisual && !visual) {
            // Canvas and custom-drawn diagrams are often exposed only as part of a WebView,
            // without a distinct ImageView node. Keep the reliable question top edge, but
            // include the remaining app content so the diagram and options are not cut off.
            left=appWindow.left;
            right=appWindow.right;
            bottom=appWindow.bottom;
            visual=true;
        }
        return new CropPlan(left-marginPx,top-marginPx,right+marginPx,bottom+marginPx,
            visual?0.72f:(preview.complete?0.9f:0.65f),
            visual?CropPlan.Source.QUESTION_PLUS_VISUAL:CropPlan.Source.QUESTION_BOUNDS);
    }
}
