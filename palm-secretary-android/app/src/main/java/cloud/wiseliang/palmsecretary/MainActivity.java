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
import java.io.InputStream;
import java.io.ByteArrayInputStream;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
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

    private WebView webView;
    private ProgressBar progress;
    private ValueCallback<Uri[]> fileCallback;
    private boolean resumed;
    private final Map<String, SharedFile> sharedFiles = new LinkedHashMap<>();

    private static final class SharedFile {
        final String id;
        final Uri uri;
        final String name;
        final String mimeType;
        final long size;

        SharedFile(String id, Uri uri, String name, String mimeType, long size) {
            this.id = id;
            this.uri = uri;
            this.name = name;
            this.mimeType = mimeType;
            this.size = size;
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
        settings.setUserAgentString(settings.getUserAgentString() + " PalmSecretaryAndroid/0.3.2");
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
            settings.setSafeBrowsingEnabled(true);
        }
        webView.addJavascriptInterface(new TaskNotificationBridge(), "PalmNative");

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
                progress.setVisibility(View.VISIBLE);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                progress.setVisibility(View.GONE);
                CookieManager.getInstance().flush();
                dispatchSharedFiles();
            }

            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri requestUri = request.getUrl();
                if (!APP_HOST.equalsIgnoreCase(requestUri.getHost()) || requestUri.getPath() == null || !requestUri.getPath().startsWith("/__native_share/")) {
                    return super.shouldInterceptRequest(view, request);
                }
                String id = requestUri.getLastPathSegment();
                SharedFile shared;
                synchronized (sharedFiles) {
                    shared = sharedFiles.remove(id);
                }
                if (shared == null) return new WebResourceResponse("text/plain", "UTF-8", 404, "Not Found", new LinkedHashMap<>(), new ByteArrayInputStream(new byte[0]));
                try {
                    InputStream input = getContentResolver().openInputStream(shared.uri);
                    Map<String, String> headers = new LinkedHashMap<>();
                    headers.put("Cache-Control", "no-store");
                    headers.put("Content-Disposition", "attachment; filename=\"" + shared.name.replace("\"", "") + "\"");
                    return new WebResourceResponse(shared.mimeType, null, 200, "OK", headers, input);
                } catch (Exception error) {
                    return new WebResourceResponse("text/plain", "UTF-8", 404, "Not Found", new LinkedHashMap<>(), new ByteArrayInputStream(new byte[0]));
                }
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
                Intent picker = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                picker.addCategory(Intent.CATEGORY_OPENABLE);
                String[] accepted = params.getAcceptTypes();
                ArrayList<String> mimeTypes = new ArrayList<>();
                if (accepted != null) {
                    for (String type : accepted) if (type != null && type.contains("/")) mimeTypes.add(type);
                }
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

    private void configureNotifications() {
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        manager.createNotificationChannel(new NotificationChannel(TASK_CHANNEL_ID, "任务进度", NotificationManager.IMPORTANCE_DEFAULT));
        if (android.os.Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, NOTIFICATION_PERMISSION_REQUEST);
        }
    }

    private final class TaskNotificationBridge {
        @JavascriptInterface
        public void notifyTask(String status) {
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
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            PendingIntent pendingIntent = PendingIntent.getActivity(MainActivity.this, 0, intent,
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
        for (Uri uri : incoming.subList(0, Math.min(10, incoming.size()))) {
            try {
                getContentResolver().takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
            } catch (Exception ignored) {
            }
            SharedFile shared = describeSharedFile(uri, intent.getType());
            synchronized (sharedFiles) {
                sharedFiles.put(shared.id, shared);
            }
        }
    }

    private SharedFile describeSharedFile(Uri uri, String fallbackMime) {
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
        return new SharedFile(UUID.randomUUID().toString(), uri, name, mime, size);
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
        dispatchSharedFiles();
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
        webView.stopLoading();
        webView.destroy();
        super.onDestroy();
    }
}
