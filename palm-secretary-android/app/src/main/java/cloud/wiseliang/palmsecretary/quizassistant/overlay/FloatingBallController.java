package cloud.wiseliang.palmsecretary.quizassistant.overlay;

import android.content.Context;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.os.Build;
import android.util.Log;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.widget.TextView;

import cloud.wiseliang.palmsecretary.R;
import cloud.wiseliang.palmsecretary.BuildConfig;
import cloud.wiseliang.palmsecretary.quizassistant.QuizAssistantPreferences;

final class FloatingBallController {
    private static final String TAG = "PalmQuizOverlay";
    interface Listener {
        void onClick();
    }

    private final Context context;
    private final WindowManager windowManager;
    private final QuizAssistantPreferences preferences;
    private final Listener listener;
    private final int size;
    private TextView view;
    private WindowManager.LayoutParams params;
    private boolean attached;
    private float downRawX;
    private float downRawY;
    private int downX;
    private int downY;
    private boolean dragging;

    FloatingBallController(Context context, WindowManager windowManager, Listener listener) {
        this.context = context;
        this.windowManager = windowManager;
        this.listener = listener;
        this.preferences = new QuizAssistantPreferences(context);
        this.size = dp(48);
    }

    void show() {
        if (attached) return;
        if (view == null) createView();
        positionFromPreferences();
        try {
            windowManager.addView(view, params);
            attached = true;
        } catch (RuntimeException error) {
            if (BuildConfig.DEBUG) Log.w(TAG, "Unable to show floating ball", error);
            attached = false;
        }
    }

    void hide() {
        if (!attached || view == null) return;
        try {
            windowManager.removeViewImmediate(view);
        } catch (RuntimeException ignored) {
        } finally {
            attached = false;
        }
    }

    void reposition() {
        if (view == null) return;
        positionFromPreferences();
        if (!attached) return;
        try {
            windowManager.updateViewLayout(view, params);
        } catch (RuntimeException ignored) {
            attached = false;
        }
    }

    private void createView() {
        view = new TextView(context);
        view.setText("AI");
        view.setTextColor(context.getColor(R.color.palm_white));
        view.setTextSize(14);
        view.setGravity(Gravity.CENTER);
        view.setTypeface(view.getTypeface(), android.graphics.Typeface.BOLD);
        view.setBackgroundResource(R.drawable.quiz_floating_ball_background);
        view.setElevation(dp(10));
        view.setContentDescription(context.getString(R.string.quiz_assistant_title));
        view.setOnTouchListener(this::onTouch);

        params = new WindowManager.LayoutParams(
            size,
            size,
            WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
            PixelFormat.TRANSLUCENT
        );
        params.gravity = Gravity.TOP | Gravity.START;
    }

    private boolean onTouch(View ignored, MotionEvent event) {
        switch (event.getActionMasked()) {
            case MotionEvent.ACTION_DOWN:
                downRawX = event.getRawX();
                downRawY = event.getRawY();
                downX = params.x;
                downY = params.y;
                dragging = false;
                return true;
            case MotionEvent.ACTION_MOVE:
                float dx = event.getRawX() - downRawX;
                float dy = event.getRawY() - downRawY;
                if (!dragging && Math.hypot(dx, dy) > dp(5)) dragging = true;
                if (dragging) {
                    Rect safe = safeBounds();
                    params.x = clamp(downX + Math.round(dx), safe.left, safe.right - size);
                    params.y = clamp(downY + Math.round(dy), safe.top, safe.bottom - size);
                    update();
                }
                return true;
            case MotionEvent.ACTION_UP:
                if (dragging) snapToEdgeAndSave();
                else listener.onClick();
                return true;
            case MotionEvent.ACTION_CANCEL:
                if (dragging) snapToEdgeAndSave();
                return true;
            default:
                return false;
        }
    }

    private void snapToEdgeAndSave() {
        Rect safe = safeBounds();
        int middle = safe.left + safe.width() / 2;
        boolean right = params.x + size / 2 >= middle;
        params.x = right ? safe.right - size : safe.left;
        params.y = clamp(params.y, safe.top, safe.bottom - size);
        int availableY = Math.max(1, safe.height() - size);
        float ratio = (params.y - safe.top) / (float) availableY;
        preferences.saveFloatingPosition(right, ratio);
        update();
    }

    private void positionFromPreferences() {
        Rect safe = safeBounds();
        params.x = preferences.isRightEdge() ? safe.right - size : safe.left;
        int availableY = Math.max(0, safe.height() - size);
        params.y = safe.top + Math.round(availableY * preferences.yRatio());
    }

    private Rect safeBounds() {
        Rect bounds;
        if (Build.VERSION.SDK_INT >= 30) {
            bounds = new Rect(windowManager.getCurrentWindowMetrics().getBounds());
            Rect displayBounds = new Rect(bounds);
            WindowInsets insets = windowManager.getCurrentWindowMetrics().getWindowInsets();
            android.graphics.Insets bars = insets.getInsetsIgnoringVisibility(
                WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars() | WindowInsets.Type.displayCutout()
            );
            int statusBar = Math.max(bars.top, systemBarDimension("status_bar_height"));
            int navigationBar = Math.max(
                Math.max(bars.bottom, systemBarDimension("navigation_bar_height")),
                dp(24)
            );
            bounds.left = bars.left + dp(6);
            bounds.top = dp(6);
            bounds.right = displayBounds.width() - bars.right - dp(6);
            bounds.bottom = displayBounds.height() - statusBar - navigationBar - dp(12);
        } else {
            android.util.DisplayMetrics metrics = new android.util.DisplayMetrics();
            windowManager.getDefaultDisplay().getRealMetrics(metrics);
            bounds = new Rect(dp(6), dp(30), metrics.widthPixels - dp(6), metrics.heightPixels - dp(42));
        }
        if (bounds.width() < size) bounds.right = bounds.left + size;
        if (bounds.height() < size) bounds.bottom = bounds.top + size;
        return bounds;
    }

    private int systemBarDimension(String name) {
        int resourceId = context.getResources().getIdentifier(name, "dimen", "android");
        return resourceId == 0 ? 0 : context.getResources().getDimensionPixelSize(resourceId);
    }

    private void update() {
        if (!attached) return;
        try {
            windowManager.updateViewLayout(view, params);
        } catch (RuntimeException ignored) {
            attached = false;
        }
    }

    private int dp(int value) {
        return Math.round(value * context.getResources().getDisplayMetrics().density);
    }

    private static int clamp(int value, int minimum, int maximum) {
        return Math.max(minimum, Math.min(maximum, value));
    }
}
