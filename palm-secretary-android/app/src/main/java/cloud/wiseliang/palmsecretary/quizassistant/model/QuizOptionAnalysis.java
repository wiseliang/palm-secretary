package cloud.wiseliang.palmsecretary.quizassistant.model;

public final class QuizOptionAnalysis {
    public final String optionId;
    public final String verdict;
    public final String explanation;

    public QuizOptionAnalysis(String optionId, String verdict, String explanation) {
        this.optionId = optionId;
        this.verdict = verdict;
        this.explanation = explanation;
    }
}
