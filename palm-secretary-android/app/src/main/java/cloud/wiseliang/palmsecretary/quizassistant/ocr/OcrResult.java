package cloud.wiseliang.palmsecretary.quizassistant.ocr;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

public final class OcrResult {
    public final String fullText;
    public final List<OcrTextLine> lines;
    public final long decodeMs;
    public final long processingMs;
    public final int blockCount;
    public final int lineCount;

    public OcrResult(String fullText, List<OcrTextLine> lines, long decodeMs,
            long processingMs, int blockCount) {
        this.fullText = fullText == null ? "" : fullText;
        this.lines = Collections.unmodifiableList(new ArrayList<>(lines));
        this.decodeMs = decodeMs;
        this.processingMs = processingMs;
        this.blockCount = blockCount;
        this.lineCount = lines.size();
    }
}
