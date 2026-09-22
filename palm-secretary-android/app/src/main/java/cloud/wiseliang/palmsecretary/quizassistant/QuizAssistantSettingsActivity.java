package cloud.wiseliang.palmsecretary.quizassistant;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ComponentName;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.net.Uri;
import android.os.Bundle;
import android.provider.Settings;
import android.text.TextUtils;
import android.view.View;
import android.widget.ArrayAdapter;
import android.widget.ListView;
import android.widget.Switch;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

import cloud.wiseliang.palmsecretary.R;
import cloud.wiseliang.palmsecretary.quizassistant.accessibility.QuizAssistantAccessibilityService;
import cloud.wiseliang.palmsecretary.quizassistant.accessibility.SensitiveScreenGuard;

public final class QuizAssistantSettingsActivity extends Activity {
    private static final String ACTION_ACCESSIBILITY_DETAILS_SETTINGS = "android.settings.ACCESSIBILITY_DETAILS_SETTINGS";
    private static final class AppChoice {
        final String label;
        final String packageName;

        AppChoice(String label, String packageName) {
            this.label = label;
            this.packageName = packageName;
        }

        @Override
        public String toString() {
            return label + "\n" + packageName;
        }
    }

    private QuizAssistantPreferences preferences;
    private Switch enabledSwitch;
    private Switch visionSwitch;
    private TextView serviceStatus;
    private ListView appList;
    private TextView emptyApps;
    private final List<AppChoice> choices = new ArrayList<>();
    private boolean updatingSwitch;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_quiz_assistant_settings);
        preferences = new QuizAssistantPreferences(this);
        appList = findViewById(R.id.quiz_app_list);
        View settingsHeader = getLayoutInflater().inflate(R.layout.quiz_assistant_settings_header, appList, false);
        appList.addHeaderView(settingsHeader, null, false);
        enabledSwitch = settingsHeader.findViewById(R.id.quiz_enabled_switch);
        visionSwitch = settingsHeader.findViewById(R.id.quiz_vision_switch);
        serviceStatus = settingsHeader.findViewById(R.id.quiz_service_status);
        emptyApps = settingsHeader.findViewById(R.id.quiz_empty_apps);

        findViewById(R.id.quiz_back).setOnClickListener(ignored -> finish());
        settingsHeader.findViewById(R.id.quiz_open_accessibility).setOnClickListener(ignored -> openAccessibilitySettings());
        enabledSwitch.setOnCheckedChangeListener((button, checked) -> {
            if (updatingSwitch) return;
            if (checked && !preferences.isPrivacyConfirmed()) {
                updatingSwitch = true;
                enabledSwitch.setChecked(false);
                updatingSwitch = false;
                showPrivacyConfirmation();
                return;
            }
            preferences.setEnabled(checked);
            QuizAssistantCoordinator.notifyPreferencesChanged();
        });
        visionSwitch.setOnCheckedChangeListener((button, checked) -> {
            if (updatingSwitch) return;
            if (!checked) { preferences.setVisionEnabled(false); return; }
            updatingSwitch = true;
            visionSwitch.setChecked(false);
            updatingSwitch = false;
            new AlertDialog.Builder(this)
                .setTitle(R.string.quiz_vision_consent_title)
                .setMessage(R.string.quiz_vision_consent_body)
                .setNegativeButton(R.string.cancel, null)
                .setPositiveButton(R.string.quiz_vision_allow, (dialog, which) -> {
                    preferences.setVisionEnabled(true);
                    updatingSwitch = true;
                    visionSwitch.setChecked(true);
                    updatingSwitch = false;
                }).show();
        });

        loadLaunchableApplications();
        refreshControls();
    }

    @Override
    protected void onResume() {
        super.onResume();
        refreshControls();
    }

    private void showPrivacyConfirmation() {
        new AlertDialog.Builder(this)
            .setTitle(R.string.quiz_assistant_consent_title)
            .setMessage(R.string.quiz_assistant_consent_body)
            .setNegativeButton(R.string.cancel, null)
            .setPositiveButton(R.string.confirm_enable, (dialog, which) -> {
                preferences.confirmPrivacy();
                preferences.setEnabled(true);
                updatingSwitch = true;
                enabledSwitch.setChecked(true);
                updatingSwitch = false;
                QuizAssistantCoordinator.notifyPreferencesChanged();
            })
            .show();
    }

    private void refreshControls() {
        updatingSwitch = true;
        enabledSwitch.setChecked(preferences.isEnabled());
        visionSwitch.setChecked(preferences.isVisionEnabled());
        updatingSwitch = false;
        boolean enabled = isAccessibilityServiceEnabled();
        serviceStatus.setText(enabled ? R.string.quiz_assistant_service_enabled : R.string.quiz_assistant_service_disabled);
        serviceStatus.setTextColor(getColor(enabled ? R.color.palm_quiz_blue : R.color.palm_quiz_muted));
    }

    private boolean isAccessibilityServiceEnabled() {
        if (Settings.Secure.getInt(getContentResolver(), Settings.Secure.ACCESSIBILITY_ENABLED, 0) != 1) return false;
        ComponentName component = new ComponentName(this, QuizAssistantAccessibilityService.class);
        String expected = component.flattenToString();
        String enabled = Settings.Secure.getString(getContentResolver(), Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
        if (enabled == null) return false;
        TextUtils.SimpleStringSplitter splitter = new TextUtils.SimpleStringSplitter(':');
        splitter.setString(enabled);
        while (splitter.hasNext()) {
            if (expected.equalsIgnoreCase(splitter.next())) return true;
        }
        return false;
    }

    private void openAccessibilitySettings() {
        ComponentName component = new ComponentName(this, QuizAssistantAccessibilityService.class);
        Intent details = new Intent(ACTION_ACCESSIBILITY_DETAILS_SETTINGS);
        details.setData(Uri.parse("package:" + getPackageName()));
        details.putExtra(Intent.EXTRA_COMPONENT_NAME, component);
        try {
            startActivity(details);
        } catch (RuntimeException error) {
            startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS));
        }
    }

    private void loadLaunchableApplications() {
        PackageManager packageManager = getPackageManager();
        Intent launcher = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
        List<ResolveInfo> resolved = packageManager.queryIntentActivities(launcher, PackageManager.MATCH_ALL);
        Set<String> seen = new HashSet<>();
        for (ResolveInfo info : resolved) {
            if (info.activityInfo == null || info.activityInfo.applicationInfo == null) continue;
            String packageName = info.activityInfo.packageName;
            if (!seen.add(packageName) || SensitiveScreenGuard.isBlocked(this, packageName)) continue;
            if (!info.activityInfo.applicationInfo.enabled) continue;
            CharSequence label = info.loadLabel(packageManager);
            choices.add(new AppChoice(label == null ? packageName : label.toString(), packageName));
        }
        Collections.sort(choices, Comparator.comparing(choice -> choice.label, java.text.Collator.getInstance()));
        ArrayAdapter<AppChoice> adapter = new ArrayAdapter<>(this, android.R.layout.simple_list_item_multiple_choice, choices);
        appList.setAdapter(adapter);
        emptyApps.setVisibility(choices.isEmpty() ? View.VISIBLE : View.GONE);
        final int headerCount = appList.getHeaderViewsCount();
        Set<String> allowed = preferences.allowedPackages();
        for (int index = 0; index < choices.size(); index++) {
            appList.setItemChecked(index + headerCount, allowed.contains(choices.get(index).packageName));
        }
        appList.setOnItemClickListener((parent, view, position, id) -> {
            int choiceIndex = position - headerCount;
            if (choiceIndex < 0 || choiceIndex >= choices.size()) return;
            AppChoice choice = choices.get(choiceIndex);
            preferences.setPackageAllowed(choice.packageName, appList.isItemChecked(position));
            QuizAssistantCoordinator.notifyPreferencesChanged();
        });
    }
}
