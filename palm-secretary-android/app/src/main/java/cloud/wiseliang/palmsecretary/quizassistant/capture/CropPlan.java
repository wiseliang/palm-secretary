package cloud.wiseliang.palmsecretary.quizassistant.capture;

public final class CropPlan {
    public enum Source { QUESTION_BOUNDS, QUESTION_PLUS_VISUAL, APP_WINDOW }
    public final int left, top, right, bottom;
    public final float confidence;
    public final Source source;

    public CropPlan(int left, int top, int right, int bottom, float confidence, Source source) {
        this.left=left; this.top=top; this.right=right; this.bottom=bottom;
        this.confidence=Math.max(0f,Math.min(1f,confidence)); this.source=source;
    }
    public boolean reliable() { return source != Source.APP_WINDOW && confidence >= 0.6f; }
}
