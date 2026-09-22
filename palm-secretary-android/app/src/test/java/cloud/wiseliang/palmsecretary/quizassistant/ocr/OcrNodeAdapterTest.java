package cloud.wiseliang.palmsecretary.quizassistant.ocr;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.List;

import org.junit.Test;

import cloud.wiseliang.palmsecretary.quizassistant.accessibility.NodeSnapshot;
import cloud.wiseliang.palmsecretary.quizassistant.accessibility.QuestionExtractor;
import cloud.wiseliang.palmsecretary.quizassistant.model.QuizQuestionPreview;

public class OcrNodeAdapterTest {
    @Test public void mergesWrappedOptionsAndReusesQuestionExtractor() {
        List<OcrTextLine> lines=new ArrayList<>();
        lines.add(line("下列关于 HTTP 与 TCP 的说法正确的是？",60,180));
        lines.add(line("A. HTTP 是应用层协议，",60,360));
        lines.add(line("可以基于 TCP 工作",90,420));
        lines.add(line("B. TCP 不提供可靠传输",60,520));
        lines.add(line("C. HTTP 只能传输中文",60,620));
        lines.add(line("D. TCP 属于物理层",60,720));
        QuizQuestionPreview preview=new QuestionExtractor().extract(new OcrNodeAdapter().adapt(lines),false);
        assertEquals(4,preview.options.size());
        assertTrue(preview.options.get(0).text.contains("可以基于 TCP 工作"));
        assertTrue(preview.confidence>=0.75f);
    }

    @Test public void preservesProfessionalCharacters() {
        List<OcrTextLine> lines=new ArrayList<>();
        lines.add(line("设备压差 ΔP 达到多少时报警？",40,160));
        lines.add(line("A. 0.2 MPa",40,320));
        lines.add(line("B. 273 mm",40,420));
        lines.add(line("C. 8000 m³/h",40,520));
        lines.add(line("D. ≥ 10 ℃",40,620));
        QuizQuestionPreview preview=new QuestionExtractor().extract(new OcrNodeAdapter().adapt(lines),false);
        assertEquals("0.2 MPa",preview.options.get(0).text);
        assertEquals("8000 m³/h",preview.options.get(2).text);
    }

    private static OcrTextLine line(String text,int left,int top) {
        return new OcrTextLine(text,new NodeSnapshot.Bounds(left,top,760,top+48));
    }
}
