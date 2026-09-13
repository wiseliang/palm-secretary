package cloud.wiseliang.palmsecretary.quizassistant.model;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

public final class QuizQuestionPreview {
    public enum QuestionType { SINGLE_CHOICE, MULTIPLE_CHOICE, TRUE_FALSE, UNKNOWN }

    public final String questionText;
    public final QuestionType questionType;
    public final List<QuizOptionPreview> options;
    public final float confidence;
    public final List<String> warnings;
    public final boolean complete;

    public QuizQuestionPreview(String questionText, QuestionType questionType,
            List<QuizOptionPreview> options, float confidence, List<String> warnings,
            boolean complete) {
        this.questionText = questionText == null ? "" : questionText;
        this.questionType = questionType == null ? QuestionType.UNKNOWN : questionType;
        this.options = Collections.unmodifiableList(new ArrayList<>(options));
        this.confidence = Math.max(0f, Math.min(1f, confidence));
        this.warnings = Collections.unmodifiableList(new ArrayList<>(warnings));
        this.complete = complete;
    }
}
