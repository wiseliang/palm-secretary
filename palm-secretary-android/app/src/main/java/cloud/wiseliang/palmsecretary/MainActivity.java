package cloud.wiseliang.palmsecretary;

import android.app.Activity;
import android.app.DownloadManager;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.Manifest;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.net.ConnectivityManager;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.content.pm.PackageManager;
import android.provider.Settings;
import android.provider.OpenableColumns;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.JavascriptInterface;
import android.webkit.SslErrorHandler;
import android.webkit.MimeTypeMap;
import android.webkit.ServiceWorkerClient;
import android.webkit.ServiceWorkerController;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.ProgressBar;
import android.widget.Toast;

import java.util.Locale;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.ByteArrayInputStream;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import org.json.JSONArray;
import org.json.JSONObject;

public final class MainActivity extends Activity {
    private static final String APP_URL = "https://ai.wiseliang.cloud/";
    private static final String APP_HOST = "ai.wiseliang.cloud";
    private static final int FILE_CHOOSER_REQUEST = 1001;
    private static final int NOTIFICATION_PERMISSION_REQUEST = 1002;
    private static final String TASK_CHANNEL_ID = "palm_tasks";
    private static final String EXTRA_PROJECT_ID = "palm_project_id";
    private static final String EXTRA_THREAD_ID = "palm_thread_id";
    private static final long MAX_SHARED_FILE_BYTES = 95L * 1024L * 1024L;

    private WebView webView;
    private ProgressBar progress;
    private ValueCallback<Uri[]> fileCallback;
    private boolean resumed;
    private volatile boolean pageReady;
    private String pendingProjectId;
    private String pendingThreadId;
    private final Map<String, SharedFile> sharedFiles = new LinkedHashMap<>();
    private final ExecutorService shareExecutor = Executors.newSingleThreadExecutor();
    private volatile String pendingShareError;

    private static final class SharedFile {
        final String id;
        final File cacheFile;
        final String name;
        final String mimeType;
        final long size;

        SharedFile(String id, File cacheFile, String name, String mimeType, long size) {
            this.id = id;
            this.cacheFile = cacheFile;
            this.name = name;
            this.mimeType = mimeType;
            this.size = size;
        }
    }

    private static final class SharedFileInfo {
        final String name;
        final String mimeType;
        final long size;

        SharedFileInfo(String name, String mimeType, long size) {
            this.name = name;
            this.mimeType = mimeType;
            this.size = size;
        }
    }

    private static final class DeletingInputStream extends FilterInputStream {
        private final File file;

        DeletingInputStream(InputStream input, File file) {
            super(input);
            this.file = file;
        }

        @Override
        public void close() throws IOException {
            try {
                super.close();
            } finally {
                if (file.exists()) file.delete();
            }
        }
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);
        webView = findViewById(R.id.web_view);
        progress = findViewById(R.id.progress);
        configureWebView();
        configureNotifications();
        receiveSharedIntent(getIntent());
        receiveTaskTarget(getIntent());

        if (savedInstanceState == null) {
            loadHome();
        } else {
            webView.restoreState(savedInstanceState);
        }
    }

    private void configureWebView() {
        WebView.setWebContentsDebuggingEnabled(false);
        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(webView, false);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setUserAgentString(settings.getUserAgentString() + " PalmSecretaryAndroid/" + BuildConfig.VERSION_NAME);
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
            settings.setSafeBrowsingEnabled(true);
        }
        webView.addJavascriptInterface(new TaskNotificationBridge(), "PalmNative");

        // A registered service worker owns same-origin fetches. Those requests
        // do not reliably pass through WebViewClient.shouldInterceptRequest,
        // so expose the native share stream through both interception paths.
        ServiceWorkerController.getInstance().setServiceWorkerClient(new ServiceWorkerClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebResourceRequest request) {
                return interceptSharedRequest(request.getUrl());
            }
        });

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (isAllowed(uri)) return false;
                openExternal(uri);
                return true;
            }

            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                pageReady = false;
                progress.setVisibility(View.VISIBLE);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                pageReady = true;
                progress.setVisibility(View.GONE);
                CookieManager.getInstance().flush();
                dispatchSharedFiles();
                if (pendingShareError != null) dispatchShareError(pendingShareError);
                dispatchTaskTarget();
            }

            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                WebResourceResponse response = interceptSharedRequest(request.getUrl());
                return response == null ? super.shouldInterceptRequest(view, request) : response;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) showOfflinePage();
            }

            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, android.net.http.SslError error) {
                handler.cancel();
                showOfflinePage();
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                progress.setProgress(newProgress);
                progress.setVisibility(newProgress < 100 ? View.VISIBLE : View.GONE);
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                String[] accepted = params.getAcceptTypes();
                ArrayList<String> mimeTypes = new ArrayList<>();
                if (accepted != null) {
                    for (String type : accepted) if (type != null && type.contains("/")) mimeTypes.add(type);
                }
                boolean imagesOnly = !mimeTypes.isEmpty();
                for (String type : mimeTypes) {
                    if (!type.startsWith("image/")) imagesOnly = false;
                }
                Intent picker = new Intent(imagesOnly ? Intent.ACTION_GET_CONTENT : Intent.ACTION_OPEN_DOCUMENT);
                picker.addCategory(Intent.CATEGORY_OPENABLE);
                picker.setType(mimeTypes.size() == 1 ? mimeTypes.get(0) : "*/*");
                if (mimeTypes.size() > 1) picker.putExtra(Intent.EXTRA_MIME_TYPES, mimeTypes.toArray(new String[0]));
                picker.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
                try {
                    startActivityForResult(picker, FILE_CHOOSER_REQUEST);
                    return true;
                } catch (ActivityNotFoundException error) {
                    fileCallback = null;
                    Toast.makeText(MainActivity.this, "未找到可用的文件选择器", Toast.LENGTH_LONG).show();
                    return false;
                }
            }
        });

        webView.setDownloadListener(createDownloadListener());
    }

    private WebResourceResponse interceptSharedRequest(Uri requestUri) {
        if (requestUri == null
            || !APP_HOST.equalsIgnoreCase(requestUri.getHost())
            || requestUri.getPath() == null
            || !requestUri.getPath().startsWith("/__native_share/")) return null;
        String id = requestUri.getLastPathSegment();
        SharedFile shared;
        synchronized (sharedFiles) {
            shared = sharedFiles.get(id);
        }
        if (shared == null) return new WebResourceResponse("text/plain", "UTF-8", 404, "Not Found", new LinkedHashMap<>(), new ByteArrayInputStream(new byte[0]));
        try {
            InputStream input = new DeletingInputStream(new FileInputStream(shared.cacheFile), shared.cacheFile);
            synchronized (sharedFiles) {
                sharedFiles.remove(id);
            }
            Map<String, String> headers = new LinkedHashMap<>();
            headers.put("Cache-Control", "no-store");
            headers.put("Content-Length", Long.toString(shared.size));
            headers.put("Content-Disposition", "attachment; filename=\"" + shared.name.replace("\"", "") + "\"");
            return new WebResourceResponse(shared.mimeType, null, 200, "OK", headers, input);
        } catch (Exception error) {
            synchronized (sharedFiles) {
                sharedFiles.remove(id);
            }
            shared.cacheFile.delete();
            dispatchShareError("无法读取分享文件，请重新分享后再试");
            return new WebResourceResponse("text/plain", "UTF-8", 404, "Not Found", new LinkedHashMap<>(), new ByteArrayInputStream(new byte[0]));
        }
    }

    private void configureNotifications() {
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        manager.createNotificationChannel(new NotificationChannel(TASK_CHANNEL_ID, "任务进度", NotificationManager.IMPORTANCE_DEFAULT));
        if (android.os.Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, NOTIFICATION_PERMISSION_REQUEST);
        }
    }

    private final class TaskNotificationBridge {
        @JavascriptInterface
        public void notifyTask(String status, String projectId, String threadId) {
            if (resumed) return;
            String title = "任务已完成";
            String message = "掌心助理已完成服务器任务";
            if ("failed".equals(status)) {
                title = "任务执行失败";
                message = "打开掌心助理查看错误并重试";
            } else if ("interrupted".equals(status)) {
                title = "任务已停止";
                message = "打开掌心助理查看当前结果";
            }
            Intent intent = new Intent(MainActivity.this, MainActivity.class)
                .putExtra(EXTRA_PROJECT_ID, projectId)
                .putExtra(EXTRA_THREAD_ID, threadId)
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            int requestCode = (projectId + ":" + threadId).hashCode() & 0x7fffffff;
            PendingIntent pendingIntent = PendingIntent.getActivity(MainActivity.this, requestCode, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            android.app.Notification notification = new android.app.Notification.Builder(MainActivity.this, TASK_CHANNEL_ID)
                .setSmallIcon(R.drawable.app_icon)
                .setContentTitle(title)
                .setContentText(message)
                .setContentIntent(pendingIntent)
                .setAutoCancel(true)
                .build();
            NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            manager.notify((int) (System.currentTimeMillis() & 0x7fffffff), notification);
        }

        @JavascriptInterface
        public void ackTaskTarget() {
            runOnUiThread(() -> {
                pendingProjectId = null;
                pendingThreadId = null;
            });
        }
    }

    private void receiveTaskTarget(Intent intent) {
        if (intent == null) return;
        String projectId = intent.getStringExtra(EXTRA_PROJECT_ID);
        String threadId = intent.getStringExtra(EXTRA_THREAD_ID);
        if (projectId == null || projectId.isEmpty() || threadId == null || threadId.isEmpty()) return;
        pendingProjectId = projectId;
        pendingThreadId = threadId;
        intent.removeExtra(EXTRA_PROJECT_ID);
        intent.removeExtra(EXTRA_THREAD_ID);
    }

    private void dispatchTaskTarget() {
        if (webView == null || pendingProjectId == null || pendingThreadId == null) return;
        try {
            JSONObject detail = new JSONObject();
            detail.put("projectId", pendingProjectId);
            detail.put("threadId", pendingThreadId);
            String script = "window.__PALM_OPEN_TASK__=" + detail.toString() + ";window.dispatchEvent(new CustomEvent('palm-open-task',{detail:window.__PALM_OPEN_TASK__}));";
            webView.evaluateJavascript(script, null);
        } catch (Exception ignored) {
            // Keep the app usable even if a malformed notification target is received.
        }
    }

    private DownloadListener createDownloadListener() {
        return (url, userAgent, contentDisposition, mimeType, contentLength) -> {
            Uri uri = Uri.parse(url);
            if (!isAllowed(uri)) {
                openExternal(uri);
                return;
            }
            try {
                String filename = downloadFileName(url, contentDisposition, mimeType);
                String resolvedMimeType = downloadMimeType(filename, mimeType);
                DownloadManager.Request request = new DownloadManager.Request(uri);
                request.setMimeType(resolvedMimeType);
                request.addRequestHeader("User-Agent", userAgent);
                String cookie = CookieManager.getInstance().getCookie(url);
                if (cookie != null && !cookie.isEmpty()) request.addRequestHeader("Cookie", cookie);
                request.setTitle(filename);
                request.setDescription("掌心助理正在下载文件");
                request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, filename);
                DownloadManager manager = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
                manager.enqueue(request);
                Toast.makeText(this, R.string.download_started, Toast.LENGTH_LONG).show();
            } catch (RuntimeException error) {
                Toast.makeText(this, R.string.download_failed, Toast.LENGTH_LONG).show();
            }
        };
    }

    private String downloadFileName(String url, String contentDisposition, String mimeType) {
        if (contentDisposition != null) {
            Matcher encoded = Pattern.compile("(?i)filename\\*\\s*=\\s*(?:UTF-8'')?([^;]+)").matcher(contentDisposition);
            if (encoded.find()) {
                String value = encoded.group(1).trim().replaceAll("^\\\"|\\\"$", "");
                try {
                    return safeFileName(URLDecoder.decode(value.replace("+", "%2B"), StandardCharsets.UTF_8.name()));
                } catch (Exception ignored) {
                    return safeFileName(value);
                }
            }

            Matcher plain = Pattern.compile("(?i)filename\\s*=\\s*(?:\\\"([^\\\"]+)\\\"|([^;]+))").matcher(contentDisposition);
            if (plain.find()) {
                String value = plain.group(1) != null ? plain.group(1) : plain.group(2);
                return safeFileName(value.trim());
            }
        }
        return safeFileName(URLUtil.guessFileName(url, contentDisposition, mimeType));
    }

    private String safeFileName(String filename) {
        String value = filename == null ? "" : filename.replace('\\', '/');
        value = value.substring(value.lastIndexOf('/') + 1).replaceAll("[\\u0000-\\u001f<>:\"/\\\\|?*]", "_").trim();
        return value.isEmpty() ? "download" : value;
    }

    private String downloadMimeType(String filename, String responseMimeType) {
        String extension = MimeTypeMap.getFileExtensionFromUrl(Uri.encode(filename, "@#&=*+-_.,:!?()/~'%"));
        String inferred = extension == null ? null : MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension.toLowerCase(Locale.ROOT));
        if (inferred != null && !inferred.isEmpty()) return inferred;
        return responseMimeType == null || responseMimeType.isEmpty() ? "application/octet-stream" : responseMimeType;
    }

    private boolean isAllowed(Uri uri) {
        return "https".equalsIgnoreCase(uri.getScheme())
            && APP_HOST.equals(uri.getHost() == null ? "" : uri.getHost().toLowerCase(Locale.ROOT));
    }

    private void openExternal(Uri uri) {
        if (uri == null) return;
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (ActivityNotFoundException ignored) {
            Toast.makeText(this, "无法打开此链接", Toast.LENGTH_LONG).show();
        }
    }

    private void loadHome() {
        if (isOnline()) webView.loadUrl(APP_URL);
        else showOfflinePage();
    }

    private void receiveSharedIntent(Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        ArrayList<Uri> incoming = new ArrayList<>();
        if (Intent.ACTION_SEND.equals(action)) {
            Uri uri = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (uri != null) incoming.add(uri);
        } else if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            ArrayList<Uri> uris = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (uris != null) incoming.addAll(uris);
        }
        ClipData clips = intent.getClipData();
        if (clips != null) {
            for (int index = 0; index < clips.getItemCount(); index++) {
                Uri uri = clips.getItemAt(index).getUri();
                if (uri != null && !incoming.contains(uri)) incoming.add(uri);
            }
        }
        Uri dataUri = intent.getData();
        if (dataUri != null && !incoming.contains(dataUri)) incoming.add(dataUri);
        if (incoming.isEmpty()) return;
        ArrayList<Uri> selected = new ArrayList<>(incoming.subList(0, Math.min(10, incoming.size())));
        String fallbackMime = intent.getType();
        shareExecutor.execute(() -> {
            ArrayList<SharedFile> prepared = new ArrayList<>();
            String errorMessage = null;
            for (Uri uri : selected) {
                try {
                    prepared.add(cacheSharedFile(uri, fallbackMime));
                } catch (Exception error) {
                    errorMessage = error.getMessage() == null ? "接收外部分享文件失败，请重试" : error.getMessage();
                }
            }
            synchronized (sharedFiles) {
                for (SharedFile shared : prepared) sharedFiles.put(shared.id, shared);
            }
            if (!prepared.isEmpty()) dispatchSharedFiles();
            if (errorMessage != null) dispatchShareError(errorMessage);
        });
    }

    private SharedFileInfo describeSharedFile(Uri uri, String fallbackMime) {
        String name = "分享文件";
        long size = -1L;
        try (Cursor cursor = getContentResolver().query(uri, new String[] { OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE }, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                int sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE);
                if (nameIndex >= 0 && cursor.getString(nameIndex) != null) name = cursor.getString(nameIndex);
                if (sizeIndex >= 0 && !cursor.isNull(sizeIndex)) size = cursor.getLong(sizeIndex);
            }
        } catch (Exception ignored) {
            String tail = uri.getLastPathSegment();
            if (tail != null && !tail.isEmpty()) name = tail;
        }
        String mime = getContentResolver().getType(uri);
        if (mime == null || mime.isEmpty()) mime = fallbackMime == null ? "application/octet-stream" : fallbackMime;
        return new SharedFileInfo(name, mime, size);
    }

    private SharedFile cacheSharedFile(Uri uri, String fallbackMime) throws IOException {
        SharedFileInfo info = describeSharedFile(uri, fallbackMime);
        if (info.size > MAX_SHARED_FILE_BYTES) throw new IOException("分享文件超过 95MB，无法上传");
        String id = UUID.randomUUID().toString();
        File directory = new File(getCacheDir(), "shared-files");
        if (!directory.exists() && !directory.mkdirs()) throw new IOException("无法创建分享文件缓存");
        File target = new File(directory, id);
        long copied = 0L;
        try (InputStream input = getContentResolver().openInputStream(uri);
             FileOutputStream output = new FileOutputStream(target)) {
            if (input == null) throw new IOException("无法读取分享文件，请重新分享后再试");
            byte[] buffer = new byte[64 * 1024];
            int count;
            while ((count = input.read(buffer)) != -1) {
                copied += count;
                if (copied > MAX_SHARED_FILE_BYTES) throw new IOException("分享文件超过 95MB，无法上传");
                output.write(buffer, 0, count);
            }
            output.flush();
        } catch (Exception error) {
            target.delete();
            if (error instanceof IOException) throw (IOException) error;
            throw new IOException("无法读取分享文件，请重新分享后再试", error);
        }
        return new SharedFile(id, target, info.name, info.mimeType, copied);
    }

    private void dispatchSharedFiles() {
        if (webView == null) return;
        JSONArray payload = new JSONArray();
        synchronized (sharedFiles) {
            for (SharedFile shared : sharedFiles.values()) {
                JSONObject item = new JSONObject();
                try {
                    item.put("id", shared.id);
                    item.put("name", shared.name);
                    item.put("mimeType", shared.mimeType);
                    item.put("size", shared.size);
                    payload.put(item);
                } catch (Exception ignored) {
                }
            }
        }
        if (payload.length() == 0) return;
        String json = payload.toString();
        webView.post(() -> webView.evaluateJavascript(
            "window.__PALM_SHARED_FILES__=" + json + ";window.dispatchEvent(new CustomEvent('palm-share',{detail:" + json + "}));",
            null
        ));
    }

    private void dispatchShareError(String message) {
        pendingShareError = message;
        if (webView == null || !pageReady) return;
        String json = JSONObject.quote(message);
        pendingShareError = null;
        webView.post(() -> webView.evaluateJavascript(
            "window.__PALM_SHARE_ERROR__=" + json + ";window.dispatchEvent(new CustomEvent('palm-share-error',{detail:" + json + "}));",
            null
        ));
    }

    private boolean isOnline() {
        ConnectivityManager manager = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        if (manager == null || manager.getActiveNetwork() == null) return false;
        NetworkCapabilities capabilities = manager.getNetworkCapabilities(manager.getActiveNetwork());
        return capabilities != null && capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
    }

    private void showOfflinePage() {
        String html = "<!doctype html><meta name=viewport content='width=device-width,initial-scale=1'>"
            + "<style>body{margin:0;background:#f5f1e8;color:#1e2a24;font-family:sans-serif;display:grid;place-items:center;min-height:100vh;text-align:center}"
            + "main{padding:32px}h1{font-size:23px}p{opacity:.7;line-height:1.7}button{border:0;border-radius:999px;padding:13px 22px;background:#1e2a24;color:white;font-size:16px}</style>"
            + "<main><h1>暂时无法连接掌心助理</h1><p>请检查手机网络后重试。</p><button onclick=location.href='" + APP_URL + "'>重新连接</button></main>";
        webView.loadDataWithBaseURL(APP_URL, html, "text/html", "UTF-8", null);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != FILE_CHOOSER_REQUEST || fileCallback == null) return;
        Uri[] result = null;
        if (resultCode == RESULT_OK && data != null) {
            ClipData clips = data.getClipData();
            if (clips != null) {
                result = new Uri[clips.getItemCount()];
                for (int index = 0; index < clips.getItemCount(); index++) result[index] = clips.getItemAt(index).getUri();
            } else if (data.getData() != null) {
                result = new Uri[] { data.getData() };
            }
        }
        fileCallback.onReceiveValue(result);
        fileCallback = null;
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        receiveSharedIntent(intent);
        receiveTaskTarget(intent);
        dispatchSharedFiles();
        dispatchTaskTarget();
    }

    @Override
    protected void onResume() {
        super.onResume();
        resumed = true;
        if (webView != null) {
            webView.onResume();
            webView.resumeTimers();
            webView.evaluateJavascript("window.dispatchEvent(new Event('palm-resume'));", null);
            dispatchSharedFiles();
            dispatchTaskTarget();
        }
    }

    @Override
    protected void onPause() {
        resumed = false;
        if (webView != null) webView.onPause();
        super.onPause();
    }

    @Override
    public void onBackPressed() {
        if (webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        webView.saveState(outState);
        super.onSaveInstanceState(outState);
    }

    @Override
    protected void onDestroy() {
        if (fileCallback != null) fileCallback.onReceiveValue(null);
        shareExecutor.shutdownNow();
        synchronized (sharedFiles) {
            for (SharedFile shared : sharedFiles.values()) shared.cacheFile.delete();
            sharedFiles.clear();
        }
        webView.stopLoading();
        webView.destroy();
        super.onDestroy();
    }
}
