package cloud.wiseliang.palmsecretary.quizassistant.accessibility;

import android.content.Context;

import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;

public final class SensitiveScreenGuard {
    private static final Set<String> BLOCKED_PACKAGES = new HashSet<>(Arrays.asList(
        "com.android.settings",
        "com.android.systemui",
        "com.android.packageinstaller",
        "com.google.android.packageinstaller",
        "com.google.android.permissioncontroller",
        "com.android.permissioncontroller",
        "com.android.vending",
        "com.google.android.gms",
        "com.google.android.apps.walletnfcrel",
        "com.android.keychain",
        "com.google.android.apps.authenticator2"
    ));

    private SensitiveScreenGuard() {}

    public static boolean isBlocked(Context context, String packageName) {
        if (packageName == null || packageName.trim().isEmpty()) return true;
        return context.getPackageName().equals(packageName) || BLOCKED_PACKAGES.contains(packageName);
    }
}
