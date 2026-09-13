package cloud.wiseliang.palmsecretary.quizassistant.capture;

import android.graphics.Bitmap;
import android.graphics.Rect;

import java.io.ByteArrayOutputStream;

public final class QuizImageProcessor {
    public static final int MAX_BYTES = 3 * 1024 * 1024;
    private static final int MAX_EDGE = 1800;

    public static final class EncodedImage {
        public final byte[] bytes;
        public final String mimeType;
        public final int width, height;
        public final long cropMs, encodeMs;
        EncodedImage(byte[] bytes,String mimeType,int width,int height,long cropMs,long encodeMs) {
            this.bytes=bytes; this.mimeType=mimeType; this.width=width; this.height=height;
            this.cropMs=cropMs; this.encodeMs=encodeMs;
        }
        public void clear() { java.util.Arrays.fill(bytes,(byte)0); }
    }

    public EncodedImage process(Bitmap source, CropPlan plan, int originX, int originY) {
        long cropStarted=android.os.SystemClock.elapsedRealtime();
        Rect crop = new Rect(plan.left-originX,plan.top-originY,plan.right-originX,plan.bottom-originY);
        crop.intersect(0,0,source.getWidth(),source.getHeight());
        if (crop.width()<32 || crop.height()<32) throw new IllegalArgumentException("invalid crop");
        Bitmap current = Bitmap.createBitmap(source,crop.left,crop.top,crop.width(),crop.height());
        try {
            int longest=Math.max(current.getWidth(),current.getHeight());
            if (longest>MAX_EDGE) {
                float ratio=MAX_EDGE/(float)longest;
                Bitmap scaled=Bitmap.createScaledBitmap(current,Math.max(1,Math.round(current.getWidth()*ratio)),
                    Math.max(1,Math.round(current.getHeight()*ratio)),true);
                if (scaled!=current) current.recycle();
                current=scaled;
            }
            long cropMs=android.os.SystemClock.elapsedRealtime()-cropStarted;
            long encodeStarted=android.os.SystemClock.elapsedRealtime();
            boolean png=(long)current.getWidth()*current.getHeight()<=900_000L;
            byte[] encoded=encode(current,png?Bitmap.CompressFormat.PNG:Bitmap.CompressFormat.JPEG,png?100:88);
            if (encoded.length>MAX_BYTES) {
                encoded=encode(current,Bitmap.CompressFormat.JPEG,78);
                png=false;
            }
            if (encoded.length>MAX_BYTES) throw new IllegalArgumentException("image too large");
            return new EncodedImage(encoded,png?"image/png":"image/jpeg",current.getWidth(),current.getHeight(),
                cropMs,android.os.SystemClock.elapsedRealtime()-encodeStarted);
        } finally {
            if (current!=source && !current.isRecycled()) current.recycle();
        }
    }

    private static byte[] encode(Bitmap bitmap, Bitmap.CompressFormat format, int quality) {
        ByteArrayOutputStream output=new ByteArrayOutputStream();
        if (!bitmap.compress(format,quality,output)) throw new IllegalStateException("encode failed");
        return output.toByteArray();
    }
}
