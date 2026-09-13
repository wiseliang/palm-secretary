package cloud.wiseliang.palmsecretary.quizassistant.model;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

public final class QuizAnalysisResult {
    public final String schemaVersion;
    public final String questionType;
    public final List<String> answer;
    public final double confidence;
    public final String shortExplanation;
    public final String fullExplanation;
    public final List<QuizOptionAnalysis> optionAnalysis;
    public final List<String> knowledgePoints;
    public final String memoryTip;
    public final List<String> warnings;

    public QuizAnalysisResult(String schemaVersion, String questionType, List<String> answer,
            double confidence, String shortExplanation, String fullExplanation,
            List<QuizOptionAnalysis> optionAnalysis, List<String> knowledgePoints,
            String memoryTip, List<String> warnings) {
        this.schemaVersion = schemaVersion;
        this.questionType = questionType;
        this.answer = immutable(answer);
        this.confidence = confidence;
        this.shortExplanation = shortExplanation;
        this.fullExplanation = fullExplanation;
        this.optionAnalysis = Collections.unmodifiableList(new ArrayList<>(optionAnalysis));
        this.knowledgePoints = immutable(knowledgePoints);
        this.memoryTip = memoryTip;
        this.warnings = immutable(warnings);
    }

    private static List<String> immutable(List<String> values) {
        return Collections.unmodifiableList(new ArrayList<>(values));
    }
}
