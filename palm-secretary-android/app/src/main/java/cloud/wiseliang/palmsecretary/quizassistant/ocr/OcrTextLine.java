package cloud.wiseliang.palmsecretary.quizassistant.ocr;

import cloud.wiseliang.palmsecretary.quizassistant.accessibility.NodeSnapshot;

public final class OcrTextLine {
    public final String text;
    public final NodeSnapshot.Bounds bounds;

    public OcrTextLine(String text, NodeSnapshot.Bounds bounds) {
        this.text = text == null ? "" : text.trim();
        this.bounds = bounds == null ? new NodeSnapshot.Bounds(0, 0, 0, 0) : bounds;
    }
}
