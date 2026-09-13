package cloud.wiseliang.palmsecretary.quizassistant.capture;

import static org.junit.Assert.assertEquals;

import java.util.Arrays;
import java.util.Collections;
import org.junit.Test;

import cloud.wiseliang.palmsecretary.quizassistant.accessibility.NodeSnapshot;
import cloud.wiseliang.palmsecretary.quizassistant.model.QuizOptionPreview;
import cloud.wiseliang.palmsecretary.quizassistant.model.QuizQuestionPreview;

public final class VisionFallbackDeciderTest {
    private static QuizQuestionPreview preview(String text,float confidence,boolean complete) {
        return new QuizQuestionPreview(text,QuizQuestionPreview.QuestionType.SINGLE_CHOICE,
            Arrays.asList(new QuizOptionPreview("A","甲"),new QuizOptionPreview("B","乙")),confidence,
            Collections.emptyList(),complete);
    }
    private static NodeSnapshot image() {
        return new NodeSnapshot("","","android.widget.ImageView","",false,true,false,false,false,
            false,false,true,false,false,new NodeSnapshot.Bounds(10,100,500,500),1,-1,Collections.emptyList());
    }

    @Test public void completeTextDoesNotCapture() {
        assertEquals(VisionFallbackDecider.Route.TEXT_ONLY,new VisionFallbackDecider().decide(
            preview("普通文字题目",.9f,true),Collections.emptyList(),true,35,true,false,true).route);
    }
    @Test public void visualQuestionUsesHybrid() {
        assertEquals(VisionFallbackDecider.Route.HYBRID,new VisionFallbackDecider().decide(
            preview("如图所示选择答案",.9f,true),Arrays.asList(image()),true,35,true,false,true).route);
    }
    @Test public void partialUsesVisionAndGuardsDeny() {
        VisionFallbackDecider decider=new VisionFallbackDecider();
        assertEquals(VisionFallbackDecider.Route.VISION_FALLBACK,decider.decide(
            preview("部分题目",.4f,false),Collections.emptyList(),true,30,true,false,true).route);
        assertEquals(VisionFallbackDecider.Route.DENIED,decider.decide(
            preview("部分题目",.4f,false),Collections.emptyList(),false,35,true,false,true).route);
        assertEquals(VisionFallbackDecider.Route.DENIED,decider.decide(
            preview("部分题目",.4f,false),Collections.emptyList(),true,29,true,false,true).route);
        assertEquals(VisionFallbackDecider.Route.DENIED,decider.decide(
            preview("部分题目",.4f,false),Collections.emptyList(),true,35,true,true,true).route);
    }
}
