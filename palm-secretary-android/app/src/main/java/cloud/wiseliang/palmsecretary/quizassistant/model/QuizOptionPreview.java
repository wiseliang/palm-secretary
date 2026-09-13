package cloud.wiseliang.palmsecretary.quizassistant.model;

public final class QuizOptionPreview {
    public final String optionId;
    public final String text;

    public QuizOptionPreview(String optionId, String text) {
        this.optionId = optionId == null ? "" : optionId;
        this.text = text == null ? "" : text;
    }
}
