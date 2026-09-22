package cloud.wiseliang.palmsecretary.quizassistant.model;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.UUID;

public final class QuizAnalysisRequest {
    public static final String SCHEMA_VERSION = "1";
    public final String clientRequestId;
    public final String sourcePackage;
    public final QuizQuestionPreview preview;
    public final String captureMode;

    public QuizAnalysisRequest(String sourcePackage, QuizQuestionPreview preview) {
        this(UUID.randomUUID().toString(), sourcePackage, preview);
    }

    public QuizAnalysisRequest(String clientRequestId, String sourcePackage, QuizQuestionPreview preview) {
        this(clientRequestId, sourcePackage, preview, "accessibility");
    }

    public QuizAnalysisRequest(String clientRequestId, String sourcePackage, QuizQuestionPreview preview,
            String captureMode) {
        this.clientRequestId = clientRequestId;
        this.sourcePackage = sourcePackage;
        this.preview = preview;
        this.captureMode = "ocr".equals(captureMode) ? "ocr" : "accessibility";
    }

    public JSONObject toJson() throws JSONException {
        JSONObject value = new JSONObject();
        value.put("schemaVersion", SCHEMA_VERSION);
        value.put("clientRequestId", clientRequestId);
        value.put("sourcePackage", sourcePackage);
        value.put("questionType", typeValue(preview.questionType));
        value.put("question", preview.questionText);
        JSONArray options = new JSONArray();
        for (QuizOptionPreview option : preview.options) {
            options.put(new JSONObject().put("optionId", option.optionId).put("text", option.text));
        }
        value.put("options", options);
        value.put("captureMode", captureMode);
        return value;
    }

    public JSONObject toVisionJson(String captureMode, int width, int height) throws JSONException {
        JSONObject value=toJson();
        value.put("captureMode",captureMode);
        value.put("imageWidth",width);
        value.put("imageHeight",height);
        return value;
    }

    private static String typeValue(QuizQuestionPreview.QuestionType type) {
        switch (type) {
            case SINGLE_CHOICE: return "single_choice";
            case MULTIPLE_CHOICE: return "multiple_choice";
            case TRUE_FALSE: return "true_false";
            default: return "unknown";
        }
    }
}
