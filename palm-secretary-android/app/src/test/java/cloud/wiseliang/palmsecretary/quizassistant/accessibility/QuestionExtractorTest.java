package cloud.wiseliang.palmsecretary.quizassistant.accessibility;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

import org.junit.Test;

import cloud.wiseliang.palmsecretary.quizassistant.model.QuizQuestionPreview;

public class QuestionExtractorTest {
    private final QuestionExtractor extractor = new QuestionExtractor();

    @Test public void extractsSingleChoice() {
        QuizQuestionPreview result = extractor.extract(questionWith("TextView", 4), false);
        assertEquals(QuizQuestionPreview.QuestionType.SINGLE_CHOICE, result.questionType);
        assertEquals(4, result.options.size());
        assertTrue(result.confidence >= 0.75f);
    }

    @Test public void extractsMultipleChoiceFromCheckboxes() {
        List<NodeSnapshot> nodes = questionWith("CheckBox", 4);
        QuizQuestionPreview result = extractor.extract(nodes, false);
        assertEquals(QuizQuestionPreview.QuestionType.MULTIPLE_CHOICE, result.questionType);
        assertEquals(4, result.options.size());
    }

    @Test public void extractsTrueFalse() {
        List<NodeSnapshot> nodes = new ArrayList<>();
        nodes.add(node("天然气的主要成分是甲烷。", "TextView", 80, 220, false));
        nodes.add(node("正确", "RadioButton", 80, 380, true));
        nodes.add(node("错误", "RadioButton", 80, 480, true));
        QuizQuestionPreview result = extractor.extract(nodes, false);
        assertEquals(QuizQuestionPreview.QuestionType.TRUE_FALSE, result.questionType);
        assertEquals(2, result.options.size());
    }

    @Test public void supportsSixOptions() {
        assertEquals(6, extractor.extract(questionWith("TextView", 6), false).options.size());
    }

    @Test public void supportsTwoOptionSingleChoice() {
        QuizQuestionPreview result = extractor.extract(questionWith("RadioButton", 2), false);
        assertEquals(QuizQuestionPreview.QuestionType.SINGLE_CHOICE, result.questionType);
        assertEquals(2, result.options.size());
    }

    @Test public void ignoresNavigationNoise() {
        List<NodeSnapshot> nodes = questionWith("TextView", 4);
        nodes.add(node("上一题", "Button", 40, 50, true));
        nodes.add(node("下一题", "Button", 800, 1100, true));
        nodes.add(node("3/20", "TextView", 500, 80, false));
        QuizQuestionPreview result = extractor.extract(nodes, false);
        assertEquals(4, result.options.size());
        assertTrue(result.questionText.length() > 10);
    }

    @Test public void ignoresBrowserSecurityStatus() {
        List<NodeSnapshot> nodes = questionWith("RadioButton", 2);
        nodes.add(node("Your connection to this site is not secure", "TextView", 80, 120, false));
        QuizQuestionPreview result = extractor.extract(nodes, false);
        assertTrue(result.questionText.startsWith("测试设备"));
    }

    @Test public void ignoresTopTitleAndPageNumber() {
        List<NodeSnapshot> nodes = questionWith("TextView", 4);
        nodes.add(node("模拟考试中心", "TextView", 80, 40, false));
        nodes.add(node("第 3 题", "TextView", 820, 120, false));
        QuizQuestionPreview result = extractor.extract(nodes, false);
        assertTrue(result.questionText.startsWith("测试设备"));
        assertEquals(4, result.options.size());
    }

    @Test public void joinsSeparatedLabelAndText() {
        List<NodeSnapshot> nodes = new ArrayList<>();
        nodes.add(node("以下哪一项属于标准测试选项？", "TextView", 80, 200, false));
        for (int index = 0; index < 4; index++) {
            int y = 380 + index * 110;
            nodes.add(nodeWithWidth(String.valueOf((char) ('A' + index)), "TextView", 80, y, 60, false));
            nodes.add(node("选项内容" + index, "TextView", 180, y, false));
        }
        assertEquals(4, extractor.extract(nodes, false).options.size());
    }

    @Test public void emptyPageFailsGracefully() {
        QuizQuestionPreview result = extractor.extract(Collections.emptyList(), false);
        assertEquals(0, result.options.size());
        assertTrue(result.confidence < 0.45f);
    }

    @Test public void truncationReducesConfidence() {
        List<NodeSnapshot> nodes = questionWith("TextView", 4);
        float normal = extractor.extract(nodes, false).confidence;
        float truncated = extractor.extract(nodes, true).confidence;
        assertTrue(truncated < normal);
    }

    @Test public void irregularOptionOrderIsNotComplete() {
        List<NodeSnapshot> nodes = questionWith("TextView", 4);
        NodeSnapshot second = nodes.get(2);
        nodes.set(2, node(second.text, second.className, 700, 340, second.clickable));
        QuizQuestionPreview result = extractor.extract(nodes, false);
        assertTrue(result.confidence < 1f);
    }

    @Test public void veryLongPageRemainsBounded() {
        List<NodeSnapshot> nodes = questionWith("TextView", 4);
        for (int index = 0; index < 500; index++) {
            nodes.add(node("辅助内容" + index, "TextView", 700, 1300 + index, false));
        }
        assertEquals(4, extractor.extract(nodes, false).options.size());
    }

    private static List<NodeSnapshot> questionWith(String optionClass, int optionCount) {
        List<NodeSnapshot> nodes = new ArrayList<>();
        nodes.add(node("测试设备中负责调节压力的主要部件是什么？", "TextView", 80, 220, false));
        for (int index = 0; index < optionCount; index++) {
            nodes.add(node((char) ('A' + index) + ". 选项内容" + index,
                optionClass, 80, 400 + index * 110, true));
        }
        return nodes;
    }

    private static NodeSnapshot node(String text, String className, int x, int y, boolean clickable) {
        return nodeWithWidth(text, className, x, y, 700, clickable);
    }

    private static NodeSnapshot nodeWithWidth(String text, String className, int x, int y,
            int width, boolean clickable) {
        return new NodeSnapshot(text, "", "android.widget." + className, "", clickable,
            true, false, false, className.equals("CheckBox"), false, false, true,
            clickable, false, new NodeSnapshot.Bounds(x, y, x + width, y + 80),
            2, -1, Collections.emptyList());
    }
}
