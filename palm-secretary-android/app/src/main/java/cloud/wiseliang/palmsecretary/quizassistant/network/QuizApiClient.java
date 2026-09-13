package cloud.wiseliang.palmsecretary.quizassistant.network;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

import cloud.wiseliang.palmsecretary.quizassistant.model.QuizAnalysisRequest;
import cloud.wiseliang.palmsecretary.quizassistant.model.QuizAnalysisResult;
import cloud.wiseliang.palmsecretary.quizassistant.model.QuizOptionAnalysis;

public final class QuizApiClient {
    public enum ErrorType { NO_SESSION, NETWORK_ERROR, TIMEOUT, MODEL_ERROR, INVALID_RESPONSE, SERVER_ERROR }

    public static final class ApiException extends Exception {
        public final ErrorType type;
        public ApiException(ErrorType type, String message) { super(message); this.type = type; }
    }

    public static final class Response {
        public final QuizAnalysisResult result;
        public final long headersMs, bodyMs, parseMs, requestMs;
        Response(QuizAnalysisResult result, long headersMs, long bodyMs, long parseMs, long requestMs) {
            this.result = result; this.headersMs = headersMs; this.bodyMs = bodyMs;
            this.parseMs = parseMs; this.requestMs = requestMs;
        }
    }

    private static final String ENDPOINT = "https://ai.wiseliang.cloud/api/quiz-analysis";
    private static final String VISION_ENDPOINT = "https://ai.wiseliang.cloud/api/quiz-analysis/vision";
    private static final int MAX_RESPONSE_BYTES = 128 * 1024;

    public Response analyze(QuizAnalysisRequest request, String cookie) throws ApiException {
        if (cookie == null || cookie.trim().isEmpty()) throw new ApiException(ErrorType.NO_SESSION, "登录已过期");
        HttpURLConnection connection = null;
        long requestStarted = android.os.SystemClock.elapsedRealtime();
        try {
            URL url = new URL(ENDPOINT);
            if (!"https".equalsIgnoreCase(url.getProtocol())) throw new ApiException(ErrorType.SERVER_ERROR, "只允许 HTTPS");
            connection = (HttpURLConnection) url.openConnection();
            connection.setRequestMethod("POST");
            connection.setConnectTimeout(5_000);
            connection.setReadTimeout(25_000);
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("Cookie", cookie);
            byte[] payload = request.toJson().toString().getBytes(StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(payload.length);
            try (OutputStream output = connection.getOutputStream()) { output.write(payload); }
            int status = connection.getResponseCode();
            long headersAt = android.os.SystemClock.elapsedRealtime();
            String body = readLimited(status >= 400 ? connection.getErrorStream() : connection.getInputStream());
            long bodyAt = android.os.SystemClock.elapsedRealtime();
            if (status < 200 || status >= 300) throw classifyHttpError(status, body);
            QuizAnalysisResult result = parseResult(body);
            long parsedAt = android.os.SystemClock.elapsedRealtime();
            return new Response(result, headersAt - requestStarted, bodyAt - headersAt,
                parsedAt - bodyAt, parsedAt - requestStarted);
        } catch (SocketTimeoutException error) {
            throw classifyTransportError(error);
        } catch (ApiException error) {
            throw error;
        } catch (IOException error) {
            throw classifyTransportError(error);
        } catch (JSONException error) {
            throw new ApiException(ErrorType.INVALID_RESPONSE, "解析结果格式异常，请重试");
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    public Response analyzeVision(QuizAnalysisRequest request, String captureMode, byte[] image,
            String mimeType, int width, int height, String cookie) throws ApiException {
        if (cookie == null || cookie.trim().isEmpty()) throw new ApiException(ErrorType.NO_SESSION,"登录已过期");
        if (image == null || image.length == 0 || image.length > 3 * 1024 * 1024) {
            throw new ApiException(ErrorType.INVALID_RESPONSE,"题目画面过大，无法上传解析。");
        }
        HttpURLConnection connection=null;
        long started=android.os.SystemClock.elapsedRealtime();
        String boundary="PalmQuiz"+java.util.UUID.randomUUID().toString().replace("-","");
        try {
            URL url=new URL(VISION_ENDPOINT);
            connection=(HttpURLConnection)url.openConnection();
            connection.setRequestMethod("POST"); connection.setConnectTimeout(5_000);
            connection.setReadTimeout(45_000); connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type","multipart/form-data; boundary="+boundary);
            connection.setRequestProperty("Accept","application/json");
            connection.setRequestProperty("Cookie",cookie);
            byte[] metadata=request.toVisionJson(captureMode,width,height).toString().getBytes(StandardCharsets.UTF_8);
            try(OutputStream out=connection.getOutputStream()) {
                writePart(out,boundary,"metadata",null,"application/json; charset=utf-8",metadata);
                writePart(out,boundary,"image","question."+("image/png".equals(mimeType)?"png":"jpg"),mimeType,image);
                out.write(("--"+boundary+"--\r\n").getBytes(StandardCharsets.US_ASCII));
            }
            int status=connection.getResponseCode();
            long headersAt=android.os.SystemClock.elapsedRealtime();
            String body=readLimited(status>=400?connection.getErrorStream():connection.getInputStream());
            long bodyAt=android.os.SystemClock.elapsedRealtime();
            if(status<200||status>=300) throw classifyHttpError(status,body);
            QuizAnalysisResult result=parseResult(body);
            long parsedAt=android.os.SystemClock.elapsedRealtime();
            return new Response(result,headersAt-started,bodyAt-headersAt,parsedAt-bodyAt,parsedAt-started);
        } catch(SocketTimeoutException error) { throw classifyTransportError(error); }
        catch(ApiException error) { throw error; }
        catch(IOException error) { throw classifyTransportError(error); }
        catch(JSONException error) { throw new ApiException(ErrorType.INVALID_RESPONSE,"解析结果格式异常，请重试"); }
        finally { if(connection!=null) connection.disconnect(); }
    }

    private static void writePart(OutputStream output,String boundary,String name,String filename,
            String contentType,byte[] bytes) throws IOException {
        String disposition="Content-Disposition: form-data; name=\""+name+"\""
            +(filename==null?"":"; filename=\""+filename+"\"");
        output.write(("--"+boundary+"\r\n"+disposition+"\r\nContent-Type: "+contentType+"\r\n\r\n")
            .getBytes(StandardCharsets.US_ASCII));
        output.write(bytes); output.write("\r\n".getBytes(StandardCharsets.US_ASCII));
    }

    public static ApiException classifyHttpError(int status, String body) {
        if (status == 401) return new ApiException(ErrorType.NO_SESSION, "掌心助理登录已过期");
        try {
            String code = new JSONObject(body).optString("code");
            if ("MODEL_OUTPUT_INVALID".equals(code)) return new ApiException(ErrorType.INVALID_RESPONSE, "解析结果格式异常，请重试");
            if ("MODEL_ERROR".equals(code)) return new ApiException(ErrorType.MODEL_ERROR, "模型暂时无法完成解析");
        } catch (JSONException ignored) { }
        return new ApiException(ErrorType.SERVER_ERROR,
            status >= 500 ? "服务器暂时不可用" : "服务器拒绝了解析请求");
    }

    public static ApiException classifyTransportError(IOException error) {
        if (error instanceof SocketTimeoutException) {
            return new ApiException(ErrorType.TIMEOUT, "解析超时，请重试");
        }
        return new ApiException(ErrorType.NETWORK_ERROR, "网络连接失败");
    }

    public static QuizAnalysisResult parseResult(String body) throws JSONException, ApiException {
        JSONObject value = new JSONObject(body);
        if (!"1".equals(required(value, "schemaVersion"))) throw invalid();
        String questionType = required(value, "questionType");
        if (!questionType.equals("single_choice") && !questionType.equals("multiple_choice")
                && !questionType.equals("true_false") && !questionType.equals("unknown")) throw invalid();
        double confidence = value.getDouble("confidence");
        if (confidence < 0 || confidence > 1) throw invalid();
        List<String> answers = strings(value.getJSONArray("answer"), 1, 12);
        List<QuizOptionAnalysis> analyses = new ArrayList<>();
        JSONArray optionValues = value.getJSONArray("optionAnalysis");
        Set<String> verdicts = new HashSet<>();
        verdicts.add("correct"); verdicts.add("incorrect"); verdicts.add("partially_correct"); verdicts.add("unknown");
        for (int index = 0; index < optionValues.length(); index++) {
            JSONObject option = optionValues.getJSONObject(index);
            String verdict = required(option, "verdict");
            if (!verdicts.contains(verdict)) throw invalid();
            analyses.add(new QuizOptionAnalysis(required(option, "optionId"), verdict,
                required(option, "explanation")));
        }
        if (analyses.size() > 12) throw invalid();
        Set<String> analyzedIds = new HashSet<>();
        for (QuizOptionAnalysis analysis : analyses) analyzedIds.add(analysis.optionId.toUpperCase(java.util.Locale.ROOT));
        for (String answer : answers) {
            if (!analyzedIds.contains(answer.toUpperCase(java.util.Locale.ROOT))) throw invalid();
        }
        return new QuizAnalysisResult("1", questionType, answers, confidence,
            required(value, "shortExplanation"), required(value, "fullExplanation"), analyses,
            strings(value.getJSONArray("knowledgePoints"), 0, 20),
            value.optString("memoryTip", ""), strings(value.getJSONArray("warnings"), 0, 10));
    }

    private static List<String> strings(JSONArray values, int min, int max) throws JSONException, ApiException {
        if (values.length() < min || values.length() > max) throw invalid();
        List<String> result = new ArrayList<>();
        for (int index = 0; index < values.length(); index++) {
            String value = values.getString(index).trim();
            if (value.isEmpty()) throw invalid();
            result.add(value);
        }
        return result;
    }

    private static String required(JSONObject value, String key) throws JSONException, ApiException {
        String result = value.getString(key).trim();
        if (result.isEmpty()) throw invalid();
        return result;
    }

    private static ApiException invalid() { return new ApiException(ErrorType.INVALID_RESPONSE, "解析结果格式异常，请重试"); }

    private static String readLimited(InputStream input) throws IOException, ApiException {
        if (input == null) return "";
        try (InputStream source = input; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[4096];
            int total = 0, count;
            while ((count = source.read(buffer)) != -1) {
                total += count;
                if (total > MAX_RESPONSE_BYTES) throw invalid();
                output.write(buffer, 0, count);
            }
            return output.toString(StandardCharsets.UTF_8.name());
        }
    }
}
