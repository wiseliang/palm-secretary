package cloud.wiseliang.palmsecretary.quizassistant.ocr;

import static org.junit.Assert.assertEquals;

import java.util.Arrays;
import java.util.Collections;

import org.junit.Test;

import cloud.wiseliang.palmsecretary.quizassistant.model.QuizOptionPreview;
import cloud.wiseliang.palmsecretary.quizassistant.model.QuizQuestionPreview;

public class OcrRoutingDeciderTest {
    private final OcrRoutingDecider decider=new OcrRoutingDecider();

    @Test public void reliableTextUsesTextApiAndThereforeNoVisionUpload() {
        assertEquals(OcrRoutingDecider.Route.TEXT_API,decider.decide(preview(0.82f,true),false));
    }

    @Test public void partialTextFallsBackToSingleExistingVisionImage() {
        assertEquals(OcrRoutingDecider.Route.VISION,decider.decide(preview(0.70f,false),false));
    }

    @Test public void visualDependencyAlwaysUsesVision() {
        assertEquals(OcrRoutingDecider.Route.VISION,decider.decide(preview(0.95f,true),true));
    }

    @Test public void genericImageContainerDoesNotSkipOcr() {
        assertEquals(true,decider.shouldRunOcr(true,false));
        assertEquals(false,decider.shouldRunOcr(true,true));
    }

    private static QuizQuestionPreview preview(float confidence,boolean complete) {
        return new QuizQuestionPreview("如需测试的固定文字题干内容？",
            QuizQuestionPreview.QuestionType.SINGLE_CHOICE,
            Arrays.asList(new QuizOptionPreview("A","选项一"),new QuizOptionPreview("B","选项二")),
            confidence,Collections.emptyList(),complete);
    }
}
