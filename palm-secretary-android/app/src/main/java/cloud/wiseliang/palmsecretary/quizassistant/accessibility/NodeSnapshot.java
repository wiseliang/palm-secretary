package cloud.wiseliang.palmsecretary.quizassistant.accessibility;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

public final class NodeSnapshot {
    public static final class Bounds {
        public final int left;
        public final int top;
        public final int right;
        public final int bottom;

        public Bounds(int left, int top, int right, int bottom) {
            this.left = left;
            this.top = top;
            this.right = right;
            this.bottom = bottom;
        }

        public int centerX() { return left + (right - left) / 2; }
        public int centerY() { return top + (bottom - top) / 2; }
        public int height() { return Math.max(0, bottom - top); }
    }

    public final String text;
    public final String contentDescription;
    public final String className;
    public final String viewIdResourceName;
    public final boolean clickable;
    public final boolean enabled;
    public final boolean editable;
    public final boolean password;
    public final boolean checkable;
    public final boolean checked;
    public final boolean selected;
    public final boolean visibleToUser;
    public final boolean focusable;
    public final boolean scrollable;
    public final Bounds boundsInScreen;
    public final int depth;
    public final int parentIndex;
    public final List<Integer> childIndexes;

    public NodeSnapshot(String text, String contentDescription, String className,
            String viewIdResourceName, boolean clickable, boolean enabled,
            boolean editable, boolean password, boolean checkable, boolean checked,
            boolean selected, boolean visibleToUser, boolean focusable, boolean scrollable,
            Bounds boundsInScreen, int depth, int parentIndex, List<Integer> childIndexes) {
        this.text = clean(text);
        this.contentDescription = clean(contentDescription);
        this.className = clean(className);
        this.viewIdResourceName = clean(viewIdResourceName);
        this.clickable = clickable;
        this.enabled = enabled;
        this.editable = editable;
        this.password = password;
        this.checkable = checkable;
        this.checked = checked;
        this.selected = selected;
        this.visibleToUser = visibleToUser;
        this.focusable = focusable;
        this.scrollable = scrollable;
        this.boundsInScreen = boundsInScreen == null ? new Bounds(0, 0, 0, 0) : boundsInScreen;
        this.depth = depth;
        this.parentIndex = parentIndex;
        this.childIndexes = Collections.unmodifiableList(new ArrayList<>(childIndexes));
    }

    public String displayText() {
        return text.isEmpty() ? contentDescription : text;
    }

    private static String clean(String value) {
        return value == null ? "" : value.trim();
    }
}
