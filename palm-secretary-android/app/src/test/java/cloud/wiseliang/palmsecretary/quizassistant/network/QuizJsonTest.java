package cloud.wiseliang.palmsecretary.quizassistant.network;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import java.util.Arrays;
import java.util.Collections;
import java.net.SocketTimeoutException;
import java.net.UnknownHostException;

import org.json.JSONObject;
import org.junit.Test;

import cloud.wiseliang.palmsecretary.quizassistant.model.QuizAnalysisRequest;
import cloud.wiseliang.palmsecretary.quizassistant.model.QuizAnalysisResult;
import cloud.wiseliang.palmsecretary.quizassistant.model.QuizOptionPreview;
import cloud.wiseliang.palmsecretary.quizassistant.model.QuizQuestionPreview;

public class QuizJsonTest {
    @Test public void requestContainsOnlyStructuredQuestionData() throws Exception {
        QuizQuestionPreview preview = new QuizQuestionPreview("固定测试题？",
            QuizQuestionPreview.QuestionType.SINGLE_CHOICE,
            Arrays.asList(new QuizOptionPreview("A", "选项一"), new QuizOptionPreview("B", "选项二")),
            0.9f, Collections.emptyList(), true);
        JSONObject json = new QuizAnalysisRequest("com.example.quiz", preview).toJson();
        assertEquals("accessibility", json.getString("captureMode"));
        assertEquals(2, json.getJSONArray("options").length());
        assertFalse(json.has("nodes"));
        assertFalse(json.has("bounds"));
        assertFalse(json.has("contentDescription"));
        assertFalse(json.has("cookie"));
    }

    @Test public void parsesStructuredAnswerArray() throws Exception {
        QuizAnalysisResult result = QuizApiClient.parseResult(validJson());
        assertEquals(Collections.singletonList("B"), result.answer);
        assertEquals("correct", result.optionAnalysis.get(1).verdict);
    }

    @Test public void rejectsStringAnswer() {
        String malformed = validJson().replace("\"answer\":[\"B\"]", "\"answer\":\"B\"");
        assertThrows(Exception.class, () -> QuizApiClient.parseResult(malformed));
    }

    @Test public void rejectsMalformedJson() {
        assertThrows(Exception.class, () -> QuizApiClient.parseResult("not-json"));
    }

    @Test public void rejectsUnknownVerdict() {
        assertThrows(Exception.class, () -> QuizApiClient.parseResult(
            validJson().replace("\"incorrect\"", "\"maybe\"")));
    }

    @Test public void classifiesHttpErrors() {
        assertEquals(QuizApiClient.ErrorType.NO_SESSION,
            QuizApiClient.classifyHttpError(401, "{}").type);
        assertEquals(QuizApiClient.ErrorType.MODEL_ERROR,
            QuizApiClient.classifyHttpError(502, "{\"code\":\"MODEL_ERROR\"}").type);
        assertEquals(QuizApiClient.ErrorType.INVALID_RESPONSE,
            QuizApiClient.classifyHttpError(502, "{\"code\":\"MODEL_OUTPUT_INVALID\"}").type);
        assertEquals(QuizApiClient.ErrorType.SERVER_ERROR,
            QuizApiClient.classifyHttpError(500, "{}").type);
    }

    @Test public void classifiesTransportErrors() {
        assertEquals(QuizApiClient.ErrorType.TIMEOUT,
            QuizApiClient.classifyTransportError(new SocketTimeoutException()).type);
        assertEquals(QuizApiClient.ErrorType.NETWORK_ERROR,
            QuizApiClient.classifyTransportError(new UnknownHostException()).type);
    }

    private static String validJson() {
        return "{\"schemaVersion\":\"1\",\"questionType\":\"single_choice\","
            + "\"answer\":[\"B\"],\"confidence\":0.9,\"shortExplanation\":\"简短解释\","
            + "\"fullExplanation\":\"完整解释\",\"optionAnalysis\":["
            + "{\"optionId\":\"A\",\"verdict\":\"incorrect\",\"explanation\":\"不符合\"},"
            + "{\"optionId\":\"B\",\"verdict\":\"correct\",\"explanation\":\"符合\"}],"
            + "\"knowledgePoints\":[\"知识点\"],\"memoryTip\":\"记忆提示\",\"warnings\":[]}";
    }
}
