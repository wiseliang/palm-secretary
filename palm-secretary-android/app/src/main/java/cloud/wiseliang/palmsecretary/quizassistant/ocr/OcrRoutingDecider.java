package cloud.wiseliang.palmsecretary.quizassistant.ocr;

import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

import cloud.wiseliang.palmsecretary.quizassistant.model.QuizOptionPreview;
import cloud.wiseliang.palmsecretary.quizassistant.model.QuizQuestionPreview;

public final class OcrRoutingDecider {
    public enum Route { TEXT_API, VISION }

    public Route decide(QuizQuestionPreview preview, boolean visualDependency) {
        return !visualDependency && reliable(preview) ? Route.TEXT_API : Route.VISION;
    }

    public boolean shouldRunOcr(boolean accessibilityHybrid, boolean explicitVisualText) {
        return !accessibilityHybrid || !explicitVisualText;
    }

    private static boolean reliable(QuizQuestionPreview preview) {
        if (!preview.complete || preview.confidence < 0.75f || preview.questionText.trim().length() < 6
                || preview.questionText.length() > 4000 || preview.options.size() < 2
                || preview.questionType == QuizQuestionPreview.QuestionType.UNKNOWN) return false;
        Set<String> ids=new HashSet<>();
        for (QuizOptionPreview option : preview.options) {
            if (!ids.add(option.optionId.toUpperCase(Locale.ROOT))) return false;
        }
        return true;
    }
}
