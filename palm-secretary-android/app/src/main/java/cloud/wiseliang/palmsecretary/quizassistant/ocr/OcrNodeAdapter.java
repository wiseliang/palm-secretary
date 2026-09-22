package cloud.wiseliang.palmsecretary.quizassistant.ocr;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import java.util.regex.Pattern;

import cloud.wiseliang.palmsecretary.quizassistant.accessibility.NodeSnapshot;

public final class OcrNodeAdapter {
    private static final Pattern OPTION = Pattern.compile("^\\s*[A-Ha-h][\\s.．、:：)）-]+.+$");

    public List<NodeSnapshot> adapt(List<OcrTextLine> source) {
        List<OcrTextLine> lines = new ArrayList<>(source == null ? Collections.emptyList() : source);
        lines.removeIf(line -> line.text.isEmpty());
        lines.sort(Comparator.comparingInt((OcrTextLine line) -> line.bounds.top)
            .thenComparingInt(line -> line.bounds.left));
        List<NodeSnapshot> result = new ArrayList<>();
        for (int index = 0; index < lines.size(); index++) {
            OcrTextLine first = lines.get(index);
            StringBuilder text = new StringBuilder(first.text);
            NodeSnapshot.Bounds bounds = first.bounds;
            if (OPTION.matcher(first.text).matches()) {
                int next = index + 1;
                while (next < lines.size() && !OPTION.matcher(lines.get(next).text).matches()
                        && continuation(bounds, lines.get(next).bounds)) {
                    OcrTextLine continuation = lines.get(next++);
                    text.append(' ').append(continuation.text);
                    bounds = union(bounds, continuation.bounds);
                }
                index = next - 1;
            }
            result.add(node(text.toString(), bounds));
        }
        addMergedQuestionCandidate(lines, result);
        return result;
    }

    private static void addMergedQuestionCandidate(List<OcrTextLine> lines, List<NodeSnapshot> result) {
        int optionIndex = -1;
        for (int index = 0; index < lines.size(); index++) {
            if (OPTION.matcher(lines.get(index).text).matches()) { optionIndex = index; break; }
        }
        if (optionIndex < 2) return;
        int start = Math.max(0, optionIndex - 4);
        StringBuilder text = new StringBuilder();
        NodeSnapshot.Bounds bounds = lines.get(start).bounds;
        for (int index = start; index < optionIndex; index++) {
            if (text.length() > 0) text.append(' ');
            text.append(lines.get(index).text);
            bounds = union(bounds, lines.get(index).bounds);
        }
        if (text.length() >= 10) result.add(node(text.toString(), bounds));
    }

    private static boolean continuation(NodeSnapshot.Bounds previous, NodeSnapshot.Bounds next) {
        int gap = next.top - previous.bottom;
        int lineHeight = Math.max(20, Math.max(previous.height(), next.height()));
        return gap >= -lineHeight / 2 && gap <= lineHeight * 2
            && next.left >= previous.left - 24 && next.left <= previous.right;
    }

    private static NodeSnapshot.Bounds union(NodeSnapshot.Bounds first, NodeSnapshot.Bounds second) {
        return new NodeSnapshot.Bounds(Math.min(first.left, second.left), Math.min(first.top, second.top),
            Math.max(first.right, second.right), Math.max(first.bottom, second.bottom));
    }

    private static NodeSnapshot node(String text, NodeSnapshot.Bounds bounds) {
        return new NodeSnapshot(text, "", "android.widget.TextView", "", false, true,
            false, false, false, false, false, true, false, false, bounds,
            0, -1, Collections.emptyList());
    }
}
