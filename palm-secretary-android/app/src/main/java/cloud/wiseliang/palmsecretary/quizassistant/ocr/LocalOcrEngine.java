package cloud.wiseliang.palmsecretary.quizassistant.ocr;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Rect;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;

import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.text.Text;
import com.google.mlkit.vision.text.TextRecognition;
import com.google.mlkit.vision.text.TextRecognizer;
import com.google.mlkit.vision.text.chinese.ChineseTextRecognizerOptions;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

import cloud.wiseliang.palmsecretary.quizassistant.accessibility.NodeSnapshot;

public final class LocalOcrEngine implements AutoCloseable {
    public interface Callback {
        void onSuccess(OcrResult result);
        void onFailure();
    }

    private static final long TIMEOUT_MS = 5_000;
    private final TextRecognizer recognizer = TextRecognition.getClient(
        new ChineseTextRecognizerOptions.Builder().build());
    private final ExecutorService decodeExecutor = Executors.newSingleThreadExecutor();
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private volatile boolean closed;

    public void recognize(byte[] encodedImage, Callback callback) {
        AtomicBoolean delivered = new AtomicBoolean();
        long startedAt = SystemClock.elapsedRealtime();
        Runnable timeout = () -> {
            if (delivered.compareAndSet(false, true)) callback.onFailure();
        };
        mainHandler.postDelayed(timeout, TIMEOUT_MS);
        decodeExecutor.execute(() -> {
            if (closed || delivered.get()) return;
            long decodeStartedAt = SystemClock.elapsedRealtime();
            Bitmap bitmap = BitmapFactory.decodeByteArray(encodedImage, 0, encodedImage.length);
            long decodeMs = SystemClock.elapsedRealtime() - decodeStartedAt;
            if (bitmap == null) {
                mainHandler.post(() -> finishFailure(delivered, timeout, callback));
                return;
            }
            try {
                recognizer.process(InputImage.fromBitmap(bitmap, 0))
                    .addOnSuccessListener(text -> {
                        OcrResult result = toResult(text, decodeMs,
                            SystemClock.elapsedRealtime() - startedAt);
                        bitmap.recycle();
                        finishSuccess(delivered, timeout, callback, result);
                    })
                    .addOnFailureListener(error -> {
                        bitmap.recycle();
                        finishFailure(delivered, timeout, callback);
                    });
            } catch (RuntimeException error) {
                bitmap.recycle();
                mainHandler.post(() -> finishFailure(delivered, timeout, callback));
            }
        });
    }

    private void finishSuccess(AtomicBoolean delivered, Runnable timeout, Callback callback,
            OcrResult result) {
        mainHandler.removeCallbacks(timeout);
        if (delivered.compareAndSet(false, true) && !closed) callback.onSuccess(result);
    }

    private void finishFailure(AtomicBoolean delivered, Runnable timeout, Callback callback) {
        mainHandler.removeCallbacks(timeout);
        if (delivered.compareAndSet(false, true) && !closed) callback.onFailure();
    }

    private static OcrResult toResult(Text text, long decodeMs, long processingMs) {
        List<OcrTextLine> lines = new ArrayList<>();
        for (Text.TextBlock block : text.getTextBlocks()) {
            for (Text.Line line : block.getLines()) {
                Rect bounds = line.getBoundingBox();
                if (bounds != null && line.getText() != null && !line.getText().trim().isEmpty()) {
                    lines.add(new OcrTextLine(line.getText(), new NodeSnapshot.Bounds(
                        bounds.left, bounds.top, bounds.right, bounds.bottom)));
                }
            }
        }
        return new OcrResult(text.getText(), lines, decodeMs, processingMs, text.getTextBlocks().size());
    }

    @Override public void close() {
        closed = true;
        mainHandler.removeCallbacksAndMessages(null);
        decodeExecutor.shutdownNow();
        recognizer.close();
    }
}
