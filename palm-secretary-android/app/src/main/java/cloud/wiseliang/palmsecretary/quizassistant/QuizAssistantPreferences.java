package cloud.wiseliang.palmsecretary.quizassistant;

import android.content.Context;
import android.content.SharedPreferences;

import java.util.Collections;
import java.util.HashSet;
import java.util.Set;

public final class QuizAssistantPreferences {
    private static final String FILE_NAME = "quiz_assistant";
    private static final String KEY_ENABLED = "enabled";
    private static final String KEY_PRIVACY_CONFIRMED = "privacy_confirmed";
    private static final String KEY_ALLOWED_PACKAGES = "allowed_packages";
    private static final String KEY_VISION_ENABLED = "vision_enabled";
    private static final String KEY_VISION_CONSENT_VERSION = "vision_consent_version";
    private static final int VISION_CONSENT_VERSION = 1;
    private static final String KEY_EDGE = "floating_edge";
    private static final String KEY_Y_RATIO = "floating_y_ratio";
    private static final String EDGE_LEFT = "left";
    private static final String EDGE_RIGHT = "right";

    private final SharedPreferences values;

    public QuizAssistantPreferences(Context context) {
        values = context.getApplicationContext().getSharedPreferences(FILE_NAME, Context.MODE_PRIVATE);
    }

    public boolean isEnabled() {
        return values.getBoolean(KEY_ENABLED, false);
    }

    public void setEnabled(boolean enabled) {
        values.edit().putBoolean(KEY_ENABLED, enabled).apply();
    }

    public boolean isPrivacyConfirmed() {
        return values.getBoolean(KEY_PRIVACY_CONFIRMED, false);
    }

    public void confirmPrivacy() {
        values.edit().putBoolean(KEY_PRIVACY_CONFIRMED, true).apply();
    }

    public boolean isVisionEnabled() {
        return values.getBoolean(KEY_VISION_ENABLED, false)
            && values.getInt(KEY_VISION_CONSENT_VERSION, 0) == VISION_CONSENT_VERSION;
    }

    public void setVisionEnabled(boolean enabled) {
        values.edit().putBoolean(KEY_VISION_ENABLED, enabled)
            .putInt(KEY_VISION_CONSENT_VERSION, enabled ? VISION_CONSENT_VERSION : 0).apply();
    }

    public Set<String> allowedPackages() {
        return Collections.unmodifiableSet(new HashSet<>(values.getStringSet(KEY_ALLOWED_PACKAGES, Collections.emptySet())));
    }

    public void setPackageAllowed(String packageName, boolean allowed) {
        Set<String> packages = new HashSet<>(allowedPackages());
        if (allowed) packages.add(packageName);
        else packages.remove(packageName);
        values.edit().putStringSet(KEY_ALLOWED_PACKAGES, packages).apply();
    }

    public boolean isPackageAllowed(String packageName) {
        return packageName != null && allowedPackages().contains(packageName);
    }

    public boolean isRightEdge() {
        return EDGE_RIGHT.equals(values.getString(KEY_EDGE, EDGE_RIGHT));
    }

    public float yRatio() {
        return Math.max(0f, Math.min(1f, values.getFloat(KEY_Y_RATIO, 0.35f)));
    }

    public void saveFloatingPosition(boolean rightEdge, float yRatio) {
        values.edit()
            .putString(KEY_EDGE, rightEdge ? EDGE_RIGHT : EDGE_LEFT)
            .putFloat(KEY_Y_RATIO, Math.max(0f, Math.min(1f, yRatio)))
            .apply();
    }
}
