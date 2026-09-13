package cloud.wiseliang.palmsecretary.quizassistant.accessibility;

import android.graphics.Rect;
import android.view.accessibility.AccessibilityNodeInfo;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Deque;
import java.util.List;

public final class AccessibilityTreeReader {
    public static final int MAX_NODES = 1500;
    public static final int MAX_DEPTH = 50;

    public static final class Result {
        public final List<NodeSnapshot> nodes;
        public final boolean truncated;
        public final int textNodeCount;
        public final int clickableCount;
        public final int radioButtonCount;
        public final int checkBoxCount;
        public final int webViewCount;
        public final int maxDepth;

        Result(List<NodeSnapshot> nodes, boolean truncated, int textNodeCount,
                int clickableCount, int radioButtonCount, int checkBoxCount,
                int webViewCount, int maxDepth) {
            this.nodes = Collections.unmodifiableList(nodes);
            this.truncated = truncated;
            this.textNodeCount = textNodeCount;
            this.clickableCount = clickableCount;
            this.radioButtonCount = radioButtonCount;
            this.checkBoxCount = checkBoxCount;
            this.webViewCount = webViewCount;
            this.maxDepth = maxDepth;
        }
    }

    private static final class Pending {
        final AccessibilityNodeInfo node;
        final int depth;
        final int parentIndex;
        Pending(AccessibilityNodeInfo node, int depth, int parentIndex) {
            this.node = node;
            this.depth = depth;
            this.parentIndex = parentIndex;
        }
    }

    private static final class MutableSnapshot {
        String text, description, className, viewId;
        boolean clickable, enabled, editable, password, checkable, checked;
        boolean selected, visible, focusable, scrollable;
        NodeSnapshot.Bounds bounds;
        int depth, parentIndex;
        final List<Integer> children = new ArrayList<>();
    }

    public boolean containsVisiblePassword(AccessibilityNodeInfo root) {
        if (root == null) return false;
        Deque<Pending> pending = new ArrayDeque<>();
        pending.push(new Pending(root, 0, -1));
        int visited = 0;
        try {
            while (!pending.isEmpty() && visited++ < MAX_NODES) {
                Pending current = pending.pop();
                AccessibilityNodeInfo node = current.node;
                try {
                    if (node.isVisibleToUser() && node.isPassword()) return true;
                    if (current.depth < MAX_DEPTH) addChildren(node, current.depth, -1, pending);
                } catch (RuntimeException ignored) {
                } finally {
                    recycle(node);
                }
            }
            return false;
        } finally {
            recyclePending(pending);
        }
    }

    public Result readAndRecycle(AccessibilityNodeInfo root) {
        if (root == null) return new Result(new ArrayList<>(), false, 0, 0, 0, 0, 0, 0);
        Deque<Pending> pending = new ArrayDeque<>();
        List<MutableSnapshot> mutable = new ArrayList<>();
        pending.push(new Pending(root, 0, -1));
        boolean truncated = false;
        int textCount = 0, clickableCount = 0, radioCount = 0, checkCount = 0, webCount = 0, maxDepth = 0;
        try {
            while (!pending.isEmpty()) {
                if (mutable.size() >= MAX_NODES) { truncated = true; break; }
                Pending current = pending.pop();
                AccessibilityNodeInfo node = current.node;
                try {
                    if (!node.isVisibleToUser()) continue;
                    MutableSnapshot item = snapshot(node, current.depth, current.parentIndex);
                    int index = mutable.size();
                    mutable.add(item);
                    if (current.parentIndex >= 0 && current.parentIndex < mutable.size()) {
                        mutable.get(current.parentIndex).children.add(index);
                    }
                    if (!item.text.isEmpty() || !item.description.isEmpty()) textCount++;
                    if (item.clickable) clickableCount++;
                    if (item.className.endsWith("RadioButton")) radioCount++;
                    if (item.className.endsWith("CheckBox")) checkCount++;
                    if (item.className.endsWith("WebView")) webCount++;
                    maxDepth = Math.max(maxDepth, current.depth);
                    if (current.depth >= MAX_DEPTH && node.getChildCount() > 0) truncated = true;
                    else addChildren(node, current.depth, index, pending);
                } catch (RuntimeException ignored) {
                } finally {
                    recycle(node);
                }
            }
        } finally {
            if (!pending.isEmpty()) truncated = true;
            recyclePending(pending);
        }
        List<NodeSnapshot> snapshots = new ArrayList<>(mutable.size());
        for (MutableSnapshot item : mutable) {
            snapshots.add(new NodeSnapshot(item.text, item.description, item.className, item.viewId,
                item.clickable, item.enabled, item.editable, item.password, item.checkable,
                item.checked, item.selected, item.visible, item.focusable, item.scrollable,
                item.bounds, item.depth, item.parentIndex, item.children));
        }
        return new Result(snapshots, truncated, textCount, clickableCount, radioCount,
            checkCount, webCount, maxDepth);
    }

    private static MutableSnapshot snapshot(AccessibilityNodeInfo node, int depth, int parentIndex) {
        MutableSnapshot item = new MutableSnapshot();
        item.text = string(node.getText());
        item.description = string(node.getContentDescription());
        item.className = string(node.getClassName());
        item.viewId = string(node.getViewIdResourceName());
        item.clickable = node.isClickable();
        item.enabled = node.isEnabled();
        item.editable = node.isEditable();
        item.password = node.isPassword();
        item.checkable = node.isCheckable();
        item.checked = node.isChecked();
        item.selected = node.isSelected();
        item.visible = node.isVisibleToUser();
        item.focusable = node.isFocusable();
        item.scrollable = node.isScrollable();
        Rect bounds = new Rect();
        node.getBoundsInScreen(bounds);
        item.bounds = new NodeSnapshot.Bounds(bounds.left, bounds.top, bounds.right, bounds.bottom);
        item.depth = depth;
        item.parentIndex = parentIndex;
        return item;
    }

    private static void addChildren(AccessibilityNodeInfo node, int depth, int parentIndex,
            Deque<Pending> pending) {
        for (int index = node.getChildCount() - 1; index >= 0; index--) {
            try {
                AccessibilityNodeInfo child = node.getChild(index);
                if (child != null) pending.push(new Pending(child, depth + 1, parentIndex));
            } catch (RuntimeException ignored) {
            }
        }
    }

    private static void recyclePending(Deque<Pending> pending) {
        while (!pending.isEmpty()) recycle(pending.pop().node);
    }

    @SuppressWarnings("deprecation")
    private static void recycle(AccessibilityNodeInfo node) {
        if (node != null) node.recycle();
    }

    private static String string(CharSequence value) {
        return value == null ? "" : value.toString().trim();
    }
}
