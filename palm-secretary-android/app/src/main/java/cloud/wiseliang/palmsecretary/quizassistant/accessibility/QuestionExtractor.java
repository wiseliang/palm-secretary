package cloud.wiseliang.palmsecretary.quizassistant.accessibility;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import cloud.wiseliang.palmsecretary.quizassistant.model.QuizOptionPreview;
import cloud.wiseliang.palmsecretary.quizassistant.model.QuizQuestionPreview;

public final class QuestionExtractor {
    private static final Pattern LABELED_OPTION = Pattern.compile(
        "^\\s*([A-Ha-h])[\\s.．、:：)）-]+(.{1,500})$", Pattern.DOTALL);
    private static final Pattern LABEL_ONLY = Pattern.compile("^\\s*([A-Ha-h])[.．、:：)）]?\\s*$");
    private static final Pattern PAGE_NUMBER = Pattern.compile(
        "^(第?\\s*\\d+\\s*[题页]?|\\d+\\s*[/／]\\s*\\d+|\\d+%)$");
    private static final Pattern URL_LIKE = Pattern.compile(
        "^(?:https?://)?[\\w.-]+(?::\\d+)?/\\S+$", Pattern.CASE_INSENSITIVE);
    private static final Set<String> NOISE = new HashSet<>(Arrays.asList(
        "上一题", "下一题", "提交", "收藏", "解析", "答题卡", "退出", "返回",
        "进度", "倒计时", "设置", "分享", "广告", "搜索", "导航栏", "确定", "取消"));
    private static final Set<String> TRUE_FALSE = new HashSet<>(Arrays.asList(
        "正确", "错误", "对", "错", "√", "×", "是", "否"));

    private static final class TextNode {
        final NodeSnapshot node;
        final String text;
        final int index;
        TextNode(NodeSnapshot node, int index) {
            this.node = node;
            this.text = normalize(node.displayText());
            this.index = index;
        }
    }

    private static final class OptionCandidate {
        final String id;
        final String text;
        final NodeSnapshot node;
        OptionCandidate(String id, String text, NodeSnapshot node) {
            this.id = id;
            this.text = text;
            this.node = node;
        }
    }

    public QuizQuestionPreview extract(List<NodeSnapshot> nodes, boolean truncated) {
        if (nodes == null || nodes.isEmpty()) return failed("页面没有可用文字节点");
        List<TextNode> texts = collectTextNodes(nodes);
        if (texts.isEmpty()) return failed("页面没有可用文字节点");
        Collections.sort(texts, Comparator
            .comparingInt((TextNode value) -> value.node.boundsInScreen.top)
            .thenComparingInt(value -> value.node.boundsInScreen.left));

        List<OptionCandidate> options = findLabeledOptions(texts);
        if (options.size() < 2) options = findControlOptions(texts);
        if (options.size() < 2) options = findTrueFalseOptions(texts);
        options = chooseSpatialOptionGroup(options);

        TextNode question = findQuestion(texts, options, nodes);
        List<String> warnings = new ArrayList<>();
        if (truncated) warnings.add("节点数量超过读取上限");
        if (question == null) warnings.add("未找到可靠题干");
        if (options.size() < 2) warnings.add("选项数量不足");
        if (!isSpatiallyOrdered(options)) warnings.add("选项空间排列不规则");

        QuizQuestionPreview.QuestionType type = inferType(texts, options);
        float confidence = score(question, options, truncated, type, texts.size());
        List<QuizOptionPreview> previews = new ArrayList<>();
        for (OptionCandidate option : options) {
            previews.add(new QuizOptionPreview(option.id, option.text));
        }
        boolean complete = question != null && options.size() >= 2 && confidence >= 0.75f;
        return new QuizQuestionPreview(question == null ? "" : question.text, type,
            previews, confidence, warnings, complete);
    }

    private static List<TextNode> collectTextNodes(List<NodeSnapshot> nodes) {
        List<TextNode> result = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        for (int index = 0; index < nodes.size(); index++) {
            NodeSnapshot node = nodes.get(index);
            String text = normalize(node.displayText());
            if (!node.visibleToUser || text.isEmpty() || text.length() > 800) continue;
            String key = text + "@" + node.boundsInScreen.left + ":" + node.boundsInScreen.top
                + ":" + node.boundsInScreen.right + ":" + node.boundsInScreen.bottom;
            if (seen.add(key)) result.add(new TextNode(node, index));
        }
        return result;
    }

    private static List<OptionCandidate> findLabeledOptions(List<TextNode> texts) {
        List<OptionCandidate> result = new ArrayList<>();
        for (int index = 0; index < texts.size(); index++) {
            TextNode value = texts.get(index);
            Matcher matcher = LABELED_OPTION.matcher(value.text);
            if (matcher.matches()) {
                result.add(new OptionCandidate(matcher.group(1).toUpperCase(Locale.ROOT),
                    normalize(matcher.group(2)), value.node));
                continue;
            }
            Matcher label = LABEL_ONLY.matcher(value.text);
            if (!label.matches() || index + 1 >= texts.size()) continue;
            TextNode next = texts.get(index + 1);
            int verticalGap = next.node.boundsInScreen.top - value.node.boundsInScreen.top;
            int horizontalGap = next.node.boundsInScreen.left - value.node.boundsInScreen.right;
            int rowTolerance = Math.max(24, Math.max(value.node.boundsInScreen.height(), next.node.boundsInScreen.height()));
            if (Math.abs(verticalGap) <= rowTolerance && horizontalGap >= -12 && horizontalGap < 500
                    && !isNoise(next.text)) {
                result.add(new OptionCandidate(label.group(1).toUpperCase(Locale.ROOT), next.text, value.node));
                index++;
            }
        }
        return result;
    }

    private static List<OptionCandidate> findControlOptions(List<TextNode> texts) {
        List<OptionCandidate> result = new ArrayList<>();
        char id = 'A';
        for (TextNode value : texts) {
            String className = value.node.className;
            if ((className.endsWith("RadioButton") || className.endsWith("CheckBox"))
                    && !isNoise(value.text)) {
                result.add(new OptionCandidate(String.valueOf(id++), value.text, value.node));
            }
        }
        return result;
    }

    private static List<OptionCandidate> findTrueFalseOptions(List<TextNode> texts) {
        List<OptionCandidate> result = new ArrayList<>();
        for (TextNode value : texts) {
            if (TRUE_FALSE.contains(value.text)) {
                result.add(new OptionCandidate(result.isEmpty() ? "A" : "B", value.text, value.node));
                if (result.size() == 2) break;
            }
        }
        return result;
    }

    private static List<OptionCandidate> chooseSpatialOptionGroup(List<OptionCandidate> candidates) {
        if (candidates.size() <= 2) return candidates;
        candidates.sort(Comparator.comparingInt(value -> value.node.boundsInScreen.top));
        List<OptionCandidate> best = new ArrayList<>();
        for (int start = 0; start < candidates.size(); start++) {
            List<OptionCandidate> group = new ArrayList<>();
            int baseLeft = candidates.get(start).node.boundsInScreen.left;
            int lastY = -1;
            char expected = candidates.get(start).id.charAt(0);
            for (int index = start; index < candidates.size(); index++) {
                OptionCandidate value = candidates.get(index);
                int y = value.node.boundsInScreen.centerY();
                if (value.id.length() != 1 || value.id.charAt(0) != expected) break;
                if (Math.abs(value.node.boundsInScreen.left - baseLeft) > 180) break;
                if (lastY >= 0 && (y <= lastY || y - lastY > 500)) break;
                group.add(value);
                expected++;
                lastY = y;
            }
            if (group.size() > best.size()) best = group;
        }
        return best.isEmpty() ? candidates : best;
    }

    private static TextNode findQuestion(List<TextNode> texts, List<OptionCandidate> options,
            List<NodeSnapshot> allNodes) {
        int firstOptionY = options.isEmpty() ? Integer.MAX_VALUE
            : options.get(0).node.boundsInScreen.top;
        TextNode best = null;
        float bestScore = -100f;
        for (TextNode value : texts) {
            if (value.node.boundsInScreen.top >= firstOptionY || isNoise(value.text)
                    || isInsideBrowserChrome(value, allNodes)
                    || LABEL_ONLY.matcher(value.text).matches()
                    || LABELED_OPTION.matcher(value.text).matches()) continue;
            float score = Math.min(3f, value.text.length() / 18f);
            if (!value.node.clickable) score += 1f;
            if (value.text.endsWith("?") || value.text.endsWith("？")) score += 1.5f;
            if (value.text.length() < 6) score -= 2f;
            if (PAGE_NUMBER.matcher(value.text).matches()) score -= 4f;
            if (firstOptionY != Integer.MAX_VALUE) {
                int gap = firstOptionY - value.node.boundsInScreen.bottom;
                if (gap >= 0 && gap < 700) score += Math.max(0.2f, 2.2f - gap / 260f);
                else if (gap > 1400) score -= 1.5f;
            }
            if (score > bestScore) { bestScore = score; best = value; }
        }
        return bestScore >= 1.5f ? best : null;
    }

    private static QuizQuestionPreview.QuestionType inferType(List<TextNode> texts,
            List<OptionCandidate> options) {
        if (options.size() == 2 && TRUE_FALSE.contains(options.get(0).text)
                && TRUE_FALSE.contains(options.get(1).text)) {
            return QuizQuestionPreview.QuestionType.TRUE_FALSE;
        }
        for (TextNode value : texts) {
            if (value.node.className.endsWith("CheckBox") || value.text.contains("多选题")
                    || value.text.contains("多项选择") || value.text.contains("可多选")) {
                return QuizQuestionPreview.QuestionType.MULTIPLE_CHOICE;
            }
        }
        return options.size() >= 2 ? QuizQuestionPreview.QuestionType.SINGLE_CHOICE
            : QuizQuestionPreview.QuestionType.UNKNOWN;
    }

    private static float score(TextNode question, List<OptionCandidate> options,
            boolean truncated, QuizQuestionPreview.QuestionType type, int textCount) {
        float score = 0f;
        if (question != null) score += 0.28f;
        if (question != null && question.text.length() >= 10) score += 0.08f;
        if (options.size() >= 2) score += 0.24f;
        if (options.size() >= 4) score += 0.10f;
        if (hasSequentialIds(options)) score += 0.10f;
        if (isSpatiallyOrdered(options)) score += 0.10f;
        if (question != null && !options.isEmpty()
                && question.node.boundsInScreen.bottom <= options.get(0).node.boundsInScreen.top) score += 0.08f;
        if (type == QuizQuestionPreview.QuestionType.TRUE_FALSE) score += 0.08f;
        if (truncated) score -= 0.12f;
        if (options.size() == 1) score -= 0.20f;
        if (textCount > 120 && options.size() < 2) score -= 0.12f;
        return Math.max(0f, Math.min(1f, score));
    }

    private static boolean hasSequentialIds(List<OptionCandidate> options) {
        if (options.size() < 2) return false;
        char expected = options.get(0).id.charAt(0);
        for (OptionCandidate option : options) {
            if (option.id.length() != 1 || option.id.charAt(0) != expected++) return false;
        }
        return true;
    }

    private static boolean isSpatiallyOrdered(List<OptionCandidate> options) {
        if (options.size() < 2) return false;
        int lastY = Integer.MIN_VALUE;
        int baseLeft = options.get(0).node.boundsInScreen.left;
        for (OptionCandidate option : options) {
            int y = option.node.boundsInScreen.centerY();
            if (y <= lastY || Math.abs(option.node.boundsInScreen.left - baseLeft) > 220) return false;
            lastY = y;
        }
        return true;
    }

    private static boolean isNoise(String text) {
        if (NOISE.contains(text) || PAGE_NUMBER.matcher(text).matches()
                || URL_LIKE.matcher(text).matches()) return true;
        if (text.toLowerCase(Locale.ROOT).contains("connection to this site")) return true;
        return text.length() <= 12 && (text.startsWith("倒计时") || text.startsWith("进度"));
    }

    private static boolean isBrowserChrome(NodeSnapshot node) {
        String id = node.viewIdResourceName.toLowerCase(Locale.ROOT);
        return id.contains("url_bar") || id.contains("location_bar")
            || id.contains("security_status") || id.contains("toolbar");
    }

    private static boolean isInsideBrowserChrome(TextNode value, List<NodeSnapshot> allNodes) {
        int index = value.index;
        for (int hops = 0; hops < 10 && index >= 0 && index < allNodes.size(); hops++) {
            NodeSnapshot node = allNodes.get(index);
            if (isBrowserChrome(node)) return true;
            index = node.parentIndex;
        }
        return false;
    }

    private static String normalize(String value) {
        return value == null ? "" : value.replace('\u00a0', ' ').replaceAll("\\s+", " ").trim();
    }

    private static QuizQuestionPreview failed(String warning) {
        return new QuizQuestionPreview("", QuizQuestionPreview.QuestionType.UNKNOWN,
            new ArrayList<>(), 0f, Arrays.asList(warning), false);
    }
}
