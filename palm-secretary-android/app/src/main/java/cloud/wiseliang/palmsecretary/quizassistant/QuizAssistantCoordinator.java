package cloud.wiseliang.palmsecretary.quizassistant;

import android.content.Context;

import java.lang.ref.WeakReference;

import cloud.wiseliang.palmsecretary.quizassistant.accessibility.QuizAssistantAccessibilityService;
import cloud.wiseliang.palmsecretary.quizassistant.accessibility.SensitiveScreenGuard;

public final class QuizAssistantCoordinator {
    private static WeakReference<QuizAssistantAccessibilityService> service = new WeakReference<>(null);

    private QuizAssistantCoordinator() {}

    public static synchronized void attach(QuizAssistantAccessibilityService value) {
        service = new WeakReference<>(value);
    }

    public static synchronized void detach(QuizAssistantAccessibilityService value) {
        if (service.get() == value) service.clear();
    }

    public static boolean isPackageAllowed(Context context, String packageName) {
        QuizAssistantPreferences preferences = new QuizAssistantPreferences(context);
        return preferences.isEnabled()
            && preferences.isPrivacyConfirmed()
            && preferences.isPackageAllowed(packageName)
            && !SensitiveScreenGuard.isBlocked(context, packageName);
    }

    public static synchronized void notifyPreferencesChanged() {
        QuizAssistantAccessibilityService connected = service.get();
        if (connected != null) connected.refreshOverlayState();
    }
}
