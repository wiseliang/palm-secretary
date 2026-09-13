package cloud.wiseliang.palmsecretary.quizassistant.capture;

import static org.junit.Assert.*;
import java.util.Arrays;
import java.util.Collections;
import org.junit.Test;
import cloud.wiseliang.palmsecretary.quizassistant.accessibility.NodeSnapshot;
import cloud.wiseliang.palmsecretary.quizassistant.model.QuizOptionPreview;
import cloud.wiseliang.palmsecretary.quizassistant.model.QuizQuestionPreview;

public final class QuizCropPlannerTest {
    private static NodeSnapshot node(String text,String cls,int l,int t,int r,int b) {
        return new NodeSnapshot(text,"",cls,"",false,true,false,false,false,false,false,true,false,false,
            new NodeSnapshot.Bounds(l,t,r,b),1,-1,Collections.emptyList());
    }
    @Test public void unionsQuestionOptionsAndVisualWithMargin() {
        QuizQuestionPreview preview=new QuizQuestionPreview("如图选择",QuizQuestionPreview.QuestionType.SINGLE_CHOICE,
            Arrays.asList(new QuizOptionPreview("A","甲"),new QuizOptionPreview("B","乙")),.9f,Collections.emptyList(),true);
        CropPlan fallback=new CropPlan(0,0,1080,2200,.2f,CropPlan.Source.APP_WINDOW);
        CropPlan plan=new QuizCropPlanner().plan(preview,Arrays.asList(node("如图选择","TextView",100,200,900,300),
            node("","ImageView",150,320,850,800),node("甲","TextView",120,850,500,920),
            node("乙","TextView",120,940,500,1010)),true,32,fallback);
        assertEquals(CropPlan.Source.QUESTION_PLUS_VISUAL,plan.source);
        assertEquals(68,plan.left); assertEquals(168,plan.top); assertEquals(932,plan.right); assertEquals(1042,plan.bottom);
        assertTrue(plan.reliable());
    }
    @Test public void fallsBackWhenNoBoundsMatch() {
        QuizQuestionPreview preview=new QuizQuestionPreview("未知",QuizQuestionPreview.QuestionType.UNKNOWN,
            Collections.emptyList(),.1f,Collections.emptyList(),false);
        CropPlan fallback=new CropPlan(10,20,900,1800,.2f,CropPlan.Source.APP_WINDOW);
        assertSame(fallback,new QuizCropPlanner().plan(preview,Collections.emptyList(),false,32,fallback));
        assertFalse(fallback.reliable());
    }
    @Test public void incompleteQuestionWithoutOptionsRequiresWindowConfirmation() {
        QuizQuestionPreview preview=new QuizQuestionPreview("浏览器工具栏",QuizQuestionPreview.QuestionType.UNKNOWN,
            Collections.emptyList(),.36f,Collections.emptyList(),false);
        CropPlan fallback=new CropPlan(0,100,1080,2200,.2f,CropPlan.Source.APP_WINDOW);
        CropPlan plan=new QuizCropPlanner().plan(preview,
            Collections.singletonList(node("浏览器工具栏","TextView",100,120,500,200)),true,32,fallback);
        assertSame(fallback,plan);
        assertFalse(plan.reliable());
    }
}
