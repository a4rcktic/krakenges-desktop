package com.krakenges.fleet;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.DownloadManager;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.PorterDuff;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.os.Message;
import android.os.Messenger;
import android.os.Parcelable;
import android.os.Process;
import android.os.ResultReceiver;
import android.text.InputType;
import android.text.TextUtils;
import android.util.Log;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputMethodManager;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.GeolocationPermissions;
import android.webkit.JsPromptResult;
import android.webkit.JsResult;
import android.webkit.PermissionRequest;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import androidx.annotation.Nullable;
import androidx.appcompat.app.AlertDialog;
import androidx.appcompat.app.AppCompatActivity;
import androidx.webkit.ProxyConfig;
import androidx.webkit.ProxyController;
import androidx.webkit.UserAgentMetadata;
import androidx.webkit.WebSettingsCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Navegador propio de Kraken Ges.
 *
 * Corre en el proceso {@code :browser} para poder llamar a
 * {@link WebView#setDataDirectorySuffix(String)} antes de crear cualquier
 * WebView. Ese sufijo aísla cookies, localStorage, IndexedDB, caché HTTP,
 * service workers y demás estado del perfil. El proceso se mata al cerrar,
 * de modo que el siguiente perfil empieza con un sufijo distinto y un
 * WebView limpio.
 *
 * La bóveda de cookies (almacenada por el lado React) es la fuente de verdad:
 * al abrir se inyectan las cookies guardadas y al cerrar se exporta el estado
 * actual antes de borrar el sandbox.
 */
public class ProfileBrowserActivity extends AppCompatActivity {

    public static final String EXTRA_PROFILE_ID = "profileId";
    public static final String EXTRA_URL = "url";
    public static final String EXTRA_TITLE = "title";
    public static final String EXTRA_PROXY = "proxy";
    public static final String EXTRA_USER_AGENT = "userAgent";
    public static final String EXTRA_COOKIES_PATH = "cookiesPath";
    public static final String EXTRA_DOMAINS = "domains";
    public static final String EXTRA_RESULT_RECEIVER = "resultReceiver";
    public static final int MSG_CLOSE = 1;

    private static final String TAG = "KrakenGesBrowser";
    private static final int FILE_CHOOSER_REQUEST = 4101;
    private static final long COOKIE_SNAPSHOT_DEBOUNCE_MS = 1500L;
    private static final long COOKIE_INJECT_TIMEOUT_MS = 10000L;
    private static final long PROXY_APPLY_TIMEOUT_MS = 8000L;
    private static final String HOME_URL = "https://www.google.com";

    /**
     * WebRTC puede revelar la IP real aunque el WebView use un proxy. No hay
     * un ajuste nativo para desactivarlo, así que se bloquea el constructor
     * antes de que la página tenga oportunidad de usarlo.
     */
    private static final String WEBRTC_BLOCK_SCRIPT =
            "(function(){"
                    + "var block=function(){throw new DOMException('WebRTC deshabilitado por Kraken Ges','NotAllowedError');};"
                    + "['RTCPeerConnection','webkitRTCPeerConnection','RTCDataChannel'].forEach(function(n){"
                    + "try{Object.defineProperty(window,n,{configurable:true,get:block});}catch(e){}"
                    + "});"
                    + "})();";

    private WebView webView;
    private EditText urlInput;
    private ProgressBar progressBar;
    private TextView statusView;
    private ResultReceiver resultReceiver;
    private String profileId;
    private String pendingUrl;
    private volatile String currentUrl;
    private String resultPath;
    private String inputCookiesPath;
    private ArrayList<String> inputDomains;
    private String proxyConfigured;
    private boolean finished;
    private volatile boolean pageLoaded;
    private boolean closeCompleted;
    private ValueCallback<Uri[]> filePathCallback;

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final ExecutorService ioExecutor = Executors.newSingleThreadExecutor();
    private final AtomicBoolean snapshotScheduled = new AtomicBoolean(false);
    private final Runnable snapshotRunnable = () -> {
        snapshotScheduled.set(false);
        // El snapshot copia SQLite y consulta CookieManager: fuera del hilo
        // principal para no bloquear la UI ni arriesgar un ANR.
        try {
            ioExecutor.execute(this::snapshotCookies);
        } catch (Throwable ignored) {
            // El executor ya se cerró (actividad destruida).
        }
    };

    private final Handler commandHandler = new Handler(Looper.getMainLooper(), msg -> {
        if (msg.what == MSG_CLOSE) {
            finishWithResult();
            return true;
        }
        return false;
    });
    private final Messenger activityMessenger = new Messenger(commandHandler);

    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        Intent intent = getIntent();
        profileId = intent.getStringExtra(EXTRA_PROFILE_ID);
        pendingUrl = normalizeUrl(intent.getStringExtra(EXTRA_URL));
        currentUrl = pendingUrl;
        resultPath = profileId != null && !profileId.isEmpty()
                ? ProfileBrowserStore.outputFile(this, profileId).getAbsolutePath()
                : null;
        inputCookiesPath = intent.getStringExtra(EXTRA_COOKIES_PATH);
        inputDomains = intent.getStringArrayListExtra(EXTRA_DOMAINS);
        resultReceiver = getResultReceiver(intent);
        proxyConfigured = intent.getStringExtra(EXTRA_PROXY);

        if (Build.VERSION.SDK_INT < 28) {
            fail("Este navegador requiere Android 9 (API 28) o superior.");
            return;
        }
        if (TextUtils.isEmpty(profileId)) {
            fail("Perfil inválido.");
            return;
        }

        // Un snapshot de una sesión anterior no debe poder leerse si el
        // snapshot final falla: se borra antes de empezar.
        if (!TextUtils.isEmpty(resultPath)) {
            //noinspection ResultOfMethodCallIgnored
            new File(resultPath).delete();
        }

        // setDataDirectorySuffix() debe ejecutarse antes de cualquier método de
        // android.webkit en este proceso. El sandbox se borra primero: la bóveda
        // de cookies es la fuente de verdad y evita reutilizar restos de una
        // sesión anterior.
        String suffix = ProfileBrowserStore.suffixFor(profileId);
        try {
            ProfileBrowserStore.deleteProfileData(this, profileId);
            WebView.setDataDirectorySuffix(suffix);
        } catch (IllegalStateException e) {
            fail("El proceso de navegación ya estaba inicializado. Cierra la app y vuelve a intentarlo.");
            return;
        } catch (Throwable t) {
            fail("No se pudo preparar el sandbox del perfil: " + t.getMessage());
            return;
        }

        if (!TextUtils.isEmpty(proxyConfigured)
                && !WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE)) {
            fail("Este WebView no soporta proxy por perfil. Actualiza Android System WebView.");
            return;
        }
        if (!TextUtils.isEmpty(proxyConfigured)
                && !WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            fail("Este WebView no permite bloquear WebRTC. Con proxy no se puede garantizar que no se filtre la IP real.");
            return;
        }

        configureWindow();
        buildUi(intent.getStringExtra(EXTRA_USER_AGENT));
        sendReady();

        try {
            ioExecutor.execute(() -> {
                List<CookieRecord> cookies = readInputCookies();
                mainHandler.post(() -> {
                    if (finished || isFinishing()) {
                        return;
                    }
                    applyProxyAndLoad(proxyConfigured, cookies);
                });
            });
        } catch (Throwable t) {
            fail("No se pudo leer la sesión del perfil: " + t.getMessage());
        }
    }

    private void configureWindow() {
        Window window = getWindow();
        window.setStatusBarColor(Color.parseColor("#06070A"));
        window.setNavigationBarColor(Color.parseColor("#06070A"));
        window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        if (Build.VERSION.SDK_INT >= 23) {
            window.getDecorView().setSystemUiVisibility(0);
        }
    }

    private void buildUi(String userAgent) {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.parseColor("#06070A"));

        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setPadding(dp(6), dp(6), dp(6), dp(6));
        bar.setBackgroundColor(Color.parseColor("#0B1018"));

        Button back = navButton("‹");
        back.setOnClickListener(v -> {
            if (webView != null && webView.canGoBack()) {
                webView.goBack();
            }
        });

        Button forward = navButton("›");
        forward.setOnClickListener(v -> {
            if (webView != null && webView.canGoForward()) {
                webView.goForward();
            }
        });

        Button reload = navButton("⟳");
        reload.setOnClickListener(v -> {
            if (webView != null) {
                webView.reload();
            }
        });

        urlInput = new EditText(this);
        urlInput.setSingleLine(true);
        urlInput.setSelectAllOnFocus(true);
        urlInput.setInputType(InputType.TYPE_TEXT_VARIATION_URI);
        urlInput.setImeOptions(EditorInfo.IME_ACTION_GO);
        urlInput.setTextColor(Color.parseColor("#F8FAFC"));
        urlInput.setHintTextColor(Color.parseColor("#94A3B8"));
        urlInput.setHint("Buscar o escribir una URL");
        urlInput.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        urlInput.setBackgroundColor(Color.TRANSPARENT);
        urlInput.setPadding(dp(10), dp(6), dp(10), dp(6));
        LinearLayout.LayoutParams urlParams = new LinearLayout.LayoutParams(
                0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        urlParams.setMargins(dp(4), 0, dp(4), 0);
        urlInput.setLayoutParams(urlParams);
        urlInput.setOnEditorActionListener((v, actionId, event) -> {
            if (actionId == EditorInfo.IME_ACTION_GO) {
                String text = urlInput.getText().toString().trim();
                if (!text.isEmpty()) {
                    String normalized = normalizeUrl(text);
                    urlInput.clearFocus();
                    hideKeyboard();
                    if (webView != null) {
                        loadInWebView(normalized);
                    }
                }
                return true;
            }
            return false;
        });

        Button close = navButton("✕");
        close.setOnClickListener(v -> finishWithResult());

        bar.addView(back);
        bar.addView(forward);
        bar.addView(reload);
        bar.addView(urlInput);
        bar.addView(close);

        progressBar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progressBar.setMax(100);
        progressBar.setProgress(0);
        progressBar.setVisibility(View.GONE);
        if (progressBar.getProgressDrawable() != null) {
            progressBar.getProgressDrawable().setColorFilter(
                    Color.parseColor("#00F0FF"), PorterDuff.Mode.SRC_IN);
        }

        statusView = new TextView(this);
        statusView.setTextColor(Color.parseColor("#94A3B8"));
        statusView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        statusView.setGravity(Gravity.CENTER);
        statusView.setPadding(dp(16), dp(8), dp(16), dp(8));
        statusView.setText("Cargando…");
        statusView.setVisibility(View.GONE);

        webView = new WebView(this);
        webView.setLayoutParams(new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        webView.setBackgroundColor(Color.parseColor("#06070A"));

        root.addView(bar);
        root.addView(progressBar);
        root.addView(statusView);
        root.addView(webView);
        setContentView(root);

        configureWebView(userAgent);
    }

    @SuppressLint({"SetJavaScriptEnabled"})
    @SuppressWarnings("deprecation")
    private void configureWebView(String userAgent) {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setSupportMultipleWindows(true);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setBuiltInZoomControls(true);
        settings.setDisplayZoomControls(false);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        if (Build.VERSION.SDK_INT >= 26) {
            settings.setSafeBrowsingEnabled(true);
        }
        if (!TextUtils.isEmpty(userAgent)) {
            settings.setUserAgentString(userAgent);
            applyUserAgentMetadata(settings, userAgent);
        }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.ALGORITHMIC_DARKENING)) {
            try {
                WebSettingsCompat.setAlgorithmicDarkeningAllowed(settings, true);
            } catch (Throwable ignored) {
                // La página seguirá funcionando con su propio esquema de color.
            }
        }

        CookieManager cookieManager = CookieManager.getInstance();
        cookieManager.setAcceptCookie(true);
        cookieManager.setAcceptThirdPartyCookies(webView, true);

        // Bloquea WebRTC antes de que la página pueda usarlo. Sin esto, un
        // sitio puede obtener la IP real aunque el tráfico pase por el proxy.
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            try {
                WebViewCompat.addDocumentStartJavaScript(
                        webView, WEBRTC_BLOCK_SCRIPT, Collections.singleton("*"));
            } catch (Throwable t) {
                Log.w(TAG, "No se pudo inyectar el bloqueo de WebRTC", t);
            }
        } else {
            Log.w(TAG, "WebView sin DOCUMENT_START_SCRIPT: WebRTC no se puede bloquear.");
        }

        webView.setWebViewClient(new BrowserClient());
        webView.setWebChromeClient(new BrowserChromeClient());
        webView.setDownloadListener(new BrowserDownloadListener());
    }

    private void applyProxyAndLoad(String proxy, List<CookieRecord> cookies) {
        if (finished) {
            return;
        }
        if (TextUtils.isEmpty(proxy)) {
            injectCookiesAndLoad(cookies);
            return;
        }

        String normalized = normalizeProxy(proxy);
        if (normalized == null) {
            fail("El proxy configurado no es válido.");
            return;
        }
        if (normalized.contains("@")) {
            // ProxyConfig no documenta autenticación por userinfo. Se intenta,
            // pero si el proxy exige 407 la carga fallará en vez de filtrar la IP.
            Log.w(TAG, "Proxy con credenciales embebidas: la autenticación puede no estar soportada por WebView.");
        }

        try {
            ProxyConfig proxyConfig = new ProxyConfig.Builder()
                    .addProxyRule(normalized)
                    .build();
            AtomicBoolean done = new AtomicBoolean(false);
            ProxyController.getInstance().setProxyOverride(
                    proxyConfig,
                    command -> mainHandler.post(command),
                    () -> {
                        if (done.compareAndSet(false, true)) {
                            mainHandler.post(() -> injectCookiesAndLoad(cookies));
                        }
                    });
            mainHandler.postDelayed(() -> {
                if (done.compareAndSet(false, true)) {
                    fail("El proxy del perfil no respondió a tiempo.");
                }
            }, PROXY_APPLY_TIMEOUT_MS);
        } catch (Throwable t) {
            fail("No se pudo aplicar el proxy del perfil: " + t.getMessage());
        }
    }

    private void injectCookiesAndLoad(List<CookieRecord> cookies) {
        if (finished || webView == null) {
            return;
        }
        CookieManager cookieManager = CookieManager.getInstance();
        cookieManager.setAcceptCookie(true);
        cookieManager.setAcceptThirdPartyCookies(webView, true);

        if (cookies == null || cookies.isEmpty()) {
            cookieManager.flush();
            loadPendingUrl();
            return;
        }

        AtomicInteger remaining = new AtomicInteger(cookies.size());
        AtomicBoolean loaded = new AtomicBoolean(false);
        Runnable loadOnce = () -> {
            if (loaded.compareAndSet(false, true)) {
                cookieManager.flush();
                loadPendingUrl();
            }
        };

        for (CookieRecord cookie : cookies) {
            try {
                cookieManager.setCookie(cookie.url(), cookie.toSetCookieHeader(), success -> {
                    if (remaining.decrementAndGet() == 0) {
                        loadOnce.run();
                    }
                });
            } catch (Throwable t) {
                if (remaining.decrementAndGet() == 0) {
                    loadOnce.run();
                }
            }
        }
        mainHandler.postDelayed(loadOnce, COOKIE_INJECT_TIMEOUT_MS);
    }

    private void loadPendingUrl() {
        if (finished || webView == null) {
            return;
        }
        String url = TextUtils.isEmpty(pendingUrl) ? HOME_URL : pendingUrl;
        currentUrl = url;
        statusView.setVisibility(View.GONE);
        progressBar.setVisibility(View.VISIBLE);
        progressBar.setProgress(0);
        loadInWebView(url);
    }

    /**
     * El manifiesto bloquea el tráfico en claro (usesCleartextTraffic=false).
     * Cargar una URL http:// daría un error críptico de WebView; se avisa
     * explícitamente en vez de fingir que se intentó.
     */
    private void loadInWebView(String url) {
        if (finished || webView == null || TextUtils.isEmpty(url)) {
            return;
        }
        if (url.regionMatches(true, 0, "http://", 0, 7)) {
            statusView.setText("Kraken Ges no permite HTTP sin cifrar. Usa una URL HTTPS.");
            statusView.setVisibility(View.VISIBLE);
            progressBar.setVisibility(View.GONE);
            return;
        }
        webView.loadUrl(url);
    }

    private void sendReady() {
        if (resultReceiver == null) {
            return;
        }
        Bundle data = new Bundle();
        data.putString("event", "ready");
        data.putString("profileId", profileId);
        data.putParcelable("messenger", activityMessenger);
        resultReceiver.send(Activity.RESULT_OK, data);
    }

    private void sendUrlChange(String url) {
        if (TextUtils.isEmpty(url)) {
            return;
        }
        currentUrl = url;
        if (resultReceiver == null) {
            return;
        }
        Bundle data = new Bundle();
        data.putString("event", "urlChange");
        data.putString("profileId", profileId);
        data.putString("url", url);
        resultReceiver.send(Activity.RESULT_OK, data);
    }

    private void sendCloseEvent() {
        if (resultReceiver == null) {
            return;
        }
        Bundle data = new Bundle();
        data.putString("event", "close");
        data.putString("profileId", profileId);
        data.putString("resultPath", resultPath);
        resultReceiver.send(Activity.RESULT_OK, data);
    }

    private void fail(String message) {
        Log.e(TAG, message);
        if (finished) {
            return;
        }
        finished = true;
        mainHandler.removeCallbacks(snapshotRunnable);
        if (resultReceiver != null) {
            Bundle data = new Bundle();
            data.putString("event", "error");
            data.putString("profileId", profileId);
            data.putString("message", message);
            resultReceiver.send(Activity.RESULT_OK, data);
        }
        Toast.makeText(this, message, Toast.LENGTH_LONG).show();
        // Si el proceso queda vivo tras un fallo (por ejemplo, porque
        // setDataDirectorySuffix ya se llamó), la siguiente apertura
        // reutilizaría un WebView ya inicializado. Se mata para empezar limpio.
        finishAndRemoveTask();
        mainHandler.postDelayed(() -> Process.killProcess(Process.myPid()), 400L);
    }

    private void finishWithResult() {
        if (finished) {
            return;
        }
        finished = true;
        mainHandler.removeCallbacks(snapshotRunnable);
        if (progressBar != null) {
            progressBar.setVisibility(View.VISIBLE);
        }
        if (statusView != null) {
            statusView.setText("Guardando sesión…");
            statusView.setVisibility(View.VISIBLE);
        }
        try {
            ioExecutor.execute(() -> {
                try {
                    snapshotCookies();
                } catch (Throwable t) {
                    Log.w(TAG, "No se pudo exportar la sesión", t);
                }
                mainHandler.post(this::completeClose);
            });
        } catch (Throwable t) {
            // El executor ya se cerró (actividad destruida): se cierra igual.
            completeClose();
        }
    }

    private void completeClose() {
        sendCloseEvent();
        destroyWebView();
        closeCompleted = true;
        finishAndRemoveTask();
        // Borrar el sandbox puede implicar muchos archivos; se hace fuera del
        // hilo principal y se mata el proceso al terminar.
        final Context appContext = getApplicationContext();
        new Thread(() -> {
            ProfileBrowserStore.deleteProfileData(appContext, profileId);
            mainHandler.postDelayed(
                    () -> Process.killProcess(Process.myPid()), 200L);
        }, "krakenges-browser-cleanup").start();
    }

    private void destroyWebView() {
        if (webView == null) {
            return;
        }
        try {
            webView.stopLoading();
            webView.loadUrl("about:blank");
            webView.clearHistory();
            webView.clearCache(true);
            webView.destroy();
        } catch (Throwable ignored) {
            // El proceso se mata igualmente; no hay nada más que limpiar.
        }
        webView = null;
    }

    private void scheduleSnapshot() {
        if (finished || profileId == null || profileId.isEmpty()) {
            return;
        }
        if (snapshotScheduled.compareAndSet(false, true)) {
            mainHandler.postDelayed(snapshotRunnable, COOKIE_SNAPSHOT_DEBOUNCE_MS);
        }
    }

    private void snapshotCookies() {
        if (profileId == null || profileId.isEmpty()) {
            return;
        }
        try {
            List<CookieRecord> cookies = harvestCookies();
            JSONObject root = new JSONObject();
            root.put("profileId", profileId);
            root.put("finalUrl", currentUrl);
            root.put("pageLoaded", pageLoaded);
            root.put("updatedAt", System.currentTimeMillis());
            JSONArray array = new JSONArray();
            for (CookieRecord cookie : cookies) {
                array.put(cookie.toJson());
            }
            root.put("cookies", array);
            ProfileBrowserStore.writeAtomically(
                    ProfileBrowserStore.outputFile(this, profileId),
                    root.toString().getBytes(StandardCharsets.UTF_8));
        } catch (Throwable t) {
            Log.w(TAG, "No se pudo guardar el snapshot de cookies", t);
        }
    }

    private List<CookieRecord> harvestCookies() {
        CookieManager cookieManager = CookieManager.getInstance();
        try {
            cookieManager.flush();
            // flush() es asíncrono; damos un margen corto antes de copiar la DB.
            Thread.sleep(120L);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } catch (Throwable ignored) {
            // getCookie() sigue siendo la fuente de valores.
        }

        Set<String> domains = new HashSet<>();
        if (!TextUtils.isEmpty(currentUrl)) {
            String host = Uri.parse(currentUrl).getHost();
            if (!TextUtils.isEmpty(host)) {
                domains.add(host);
            }
        }
        domains.addAll(readInputDomains());

        Map<String, CookieRecord> dbCookies = readCookieDatabase(domains);
        Map<String, CookieRecord> result = new HashMap<>();

        for (String domain : domains) {
            if (TextUtils.isEmpty(domain)) {
                continue;
            }
            String bareDomain = domain.startsWith("www.") ? domain.substring(4) : domain;
            for (String scheme : new String[]{"https://", "http://"}) {
                for (String host : new String[]{bareDomain, "www." + bareDomain}) {
                    String url = scheme + host;
                    String header = null;
                    try {
                        header = cookieManager.getCookie(url);
                    } catch (Throwable ignored) {
                        // Sin cookie para este host.
                    }
                    if (TextUtils.isEmpty(header)) {
                        continue;
                    }
                    for (String pair : header.split(";\\s*")) {
                        String[] kv = pair.split("=", 2);
                        if (kv.length != 2 || kv[0].trim().isEmpty()) {
                            continue;
                        }
                        String name = kv[0].trim();
                        String value = kv[1].trim();
                        String key = host.toLowerCase(Locale.US) + "|" + name;
                        CookieRecord attributes = dbCookies.get(key);
                        CookieRecord cookie;
                        if (attributes != null) {
                            cookie = new CookieRecord(
                                    attributes.domain,
                                    name,
                                    value,
                                    attributes.path,
                                    attributes.secure,
                                    attributes.httpOnly,
                                    attributes.sameSite);
                        } else {
                            cookie = new CookieRecord(
                                    "." + host,
                                    name,
                                    value,
                                    "/",
                                    scheme.startsWith("https"),
                                    false,
                                    -1);
                        }
                        result.put(dedupKey(cookie), cookie);
                    }
                }
            }
        }

        // Cookies de la DB cuyo valor sea legible y que no hayan aparecido en
        // getCookie() (por ejemplo, cookies de un host que ya no está en la
        // lista de dominios visitados).
        for (CookieRecord cookie : dbCookies.values()) {
            if (TextUtils.isEmpty(cookie.value)) {
                continue;
            }
            result.putIfAbsent(dedupKey(cookie), cookie);
        }

        return new ArrayList<>(result.values());
    }

    private Map<String, CookieRecord> readCookieDatabase(Set<String> domains) {
        Map<String, CookieRecord> result = new HashMap<>();
        File base = ProfileBrowserStore.webViewDataDir(this, profileId);
        File[] candidates = new File[]{
                new File(base, "Cookies"),
                new File(base, "Default/Cookies"),
                new File(base, "Network/Cookies"),
                new File(base, "Default/Network/Cookies")
        };
        File tempDir = new File(getCacheDir(), "cookie_scan");
        //noinspection ResultOfMethodCallIgnored
        tempDir.mkdirs();

        for (File dbFile : candidates) {
            if (!dbFile.isFile()) {
                continue;
            }
            File tempDb = new File(tempDir, "cookies.db");
            try {
                copyFile(dbFile, tempDb);
                copyIfExists(new File(dbFile.getAbsolutePath() + "-wal"),
                        new File(tempDb.getAbsolutePath() + "-wal"));
                copyIfExists(new File(dbFile.getAbsolutePath() + "-shm"),
                        new File(tempDb.getAbsolutePath() + "-shm"));
                SQLiteDatabase db = SQLiteDatabase.openDatabase(
                        tempDb.getAbsolutePath(), null, SQLiteDatabase.OPEN_READONLY);
                try {
                    readCookieRows(db, domains, result);
                } finally {
                    db.close();
                }
            } catch (Throwable t) {
                Log.w(TAG, "No se pudo leer la base de cookies " + dbFile, t);
            } finally {
                //noinspection ResultOfMethodCallIgnored
                tempDb.delete();
                //noinspection ResultOfMethodCallIgnored
                new File(tempDb.getAbsolutePath() + "-wal").delete();
                //noinspection ResultOfMethodCallIgnored
                new File(tempDb.getAbsolutePath() + "-shm").delete();
            }
        }
        return result;
    }

    private void readCookieRows(SQLiteDatabase db, Set<String> domains,
                                Map<String, CookieRecord> result) {
        Cursor cursor = null;
        try {
            try {
                cursor = db.rawQuery(
                        "SELECT host_key, name, value, path, is_secure, is_httponly, samesite FROM cookies",
                        null);
            } catch (Throwable ignored) {
                cursor = db.rawQuery(
                        "SELECT host_key, name, value, path, is_secure, is_httponly, -1 FROM cookies",
                        null);
            }
            if (cursor == null) {
                return;
            }
            int hostIndex = cursor.getColumnIndex("host_key");
            int nameIndex = cursor.getColumnIndex("name");
            int valueIndex = cursor.getColumnIndex("value");
            int pathIndex = cursor.getColumnIndex("path");
            int secureIndex = cursor.getColumnIndex("is_secure");
            int httpOnlyIndex = cursor.getColumnIndex("is_httponly");
            int sameSiteIndex = cursor.getColumnIndex("samesite");

            while (cursor.moveToNext()) {
                String host = hostIndex >= 0 ? cursor.getString(hostIndex) : null;
                String name = nameIndex >= 0 ? cursor.getString(nameIndex) : null;
                if (TextUtils.isEmpty(host) || TextUtils.isEmpty(name)) {
                    continue;
                }
                String value = valueIndex >= 0 ? cursor.getString(valueIndex) : "";
                if (value == null || value.startsWith("v10") || value.startsWith("v11")) {
                    // Valores cifrados por Chromium: getCookie() los resuelve.
                    value = "";
                }
                String path = pathIndex >= 0 ? cursor.getString(pathIndex) : "/";
                boolean secure = secureIndex >= 0 && cursor.getInt(secureIndex) != 0;
                boolean httpOnly = httpOnlyIndex >= 0 && cursor.getInt(httpOnlyIndex) != 0;
                int sameSite = sameSiteIndex >= 0 ? cursor.getInt(sameSiteIndex) : -1;
                String normalizedHost = host.startsWith(".") ? host.substring(1) : host;
                domains.add(normalizedHost);
                String key = normalizedHost.toLowerCase(Locale.US) + "|" + name;
                result.put(key, new CookieRecord(
                        host,
                        name,
                        value,
                        TextUtils.isEmpty(path) ? "/" : path,
                        secure,
                        httpOnly,
                        sameSite));
            }
        } finally {
            if (cursor != null) {
                cursor.close();
            }
        }
    }

    private List<CookieRecord> readInputCookies() {
        List<CookieRecord> result = new ArrayList<>();
        if (TextUtils.isEmpty(inputCookiesPath)) {
            return result;
        }
        File input = new File(inputCookiesPath);
        if (!input.isFile()) {
            return result;
        }
        try (FileInputStream in = new FileInputStream(input)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int read;
            while ((read = in.read(buffer)) != -1) {
                out.write(buffer, 0, read);
            }
            JSONObject root = new JSONObject(new String(out.toByteArray(), StandardCharsets.UTF_8));
            JSONArray array = root.optJSONArray("cookies");
            if (array == null) {
                return result;
            }
            for (int i = 0; i < array.length(); i++) {
                JSONObject object = array.optJSONObject(i);
                if (object == null) {
                    continue;
                }
                String domain = object.optString("domain", "");
                String name = object.optString("name", "");
                if (TextUtils.isEmpty(domain) || TextUtils.isEmpty(name)) {
                    continue;
                }
                result.add(new CookieRecord(
                        domain,
                        name,
                        object.optString("value", ""),
                        object.optString("path", "/"),
                        object.optBoolean("secure", false),
                        object.optBoolean("httpOnly", false),
                        parseSameSite(object.optString("sameSite", ""))));
            }
        } catch (Throwable t) {
            Log.w(TAG, "No se pudieron leer las cookies de entrada", t);
        } finally {
            // El archivo de entrada contiene cookies en claro; ya se leyó, no
            // debe quedar en el almacenamiento interno.
            //noinspection ResultOfMethodCallIgnored
            input.delete();
        }
        return result;
    }

    private List<String> readInputDomains() {
        return inputDomains != null ? inputDomains : Collections.emptyList();
    }

    private static String dedupKey(CookieRecord cookie) {
        return cookie.domain.toLowerCase(Locale.US) + "|" + cookie.name + "|" + cookie.path;
    }

    private static int parseSameSite(String value) {
        if (value == null) {
            return -1;
        }
        switch (value.toLowerCase(Locale.US)) {
            case "none":
                return 0;
            case "lax":
                return 1;
            case "strict":
                return 2;
            default:
                return -1;
        }
    }

    private static void copyFile(File source, File target) throws Exception {
        try (FileInputStream in = new FileInputStream(source);
             FileOutputStream out = new FileOutputStream(target)) {
            byte[] buffer = new byte[8192];
            int read;
            while ((read = in.read(buffer)) != -1) {
                out.write(buffer, 0, read);
            }
            out.flush();
        }
    }

    private static void copyIfExists(File source, File target) {
        if (!source.isFile()) {
            return;
        }
        try {
            copyFile(source, target);
        } catch (Throwable t) {
            Log.w(TAG, "No se pudo copiar " + source, t);
        }
    }

    private static String normalizeUrl(String input) {
        if (input == null) {
            return HOME_URL;
        }
        String value = input.trim();
        if (value.isEmpty()) {
            return HOME_URL;
        }
        String lower = value.toLowerCase(Locale.US);
        if (lower.startsWith("http://")
                || lower.startsWith("https://")
                || lower.startsWith("about:")
                || lower.startsWith("data:")
                || lower.startsWith("blob:")) {
            return value;
        }
        if (value.contains(" ") || !value.contains(".")) {
            return "https://www.google.com/search?q=" + Uri.encode(value);
        }
        return "https://" + value;
    }

    private static String normalizeProxy(String raw) {
        String value = raw.trim();
        if (value.isEmpty()) {
            return null;
        }
        if (value.contains("://")) {
            return value;
        }
        if (value.startsWith("[")) {
            return "http://" + value;
        }
        // split con límite 4 para que una contraseña con ":" no rompa el parseo.
        String[] parts = value.split(":", 4);
        if (parts.length == 4) {
            // host:port:user:pass, el formato que usa el backend de escritorio.
            return "http://" + parts[2] + ":" + parts[3] + "@" + parts[0] + ":" + parts[1];
        }
        if (parts.length == 2) {
            return "http://" + parts[0] + ":" + parts[1];
        }
        if (parts.length == 1) {
            return "http://" + parts[0];
        }
        return null;
    }

    private void applyUserAgentMetadata(WebSettings settings, String userAgent) {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.USER_AGENT_METADATA)) {
            return;
        }
        try {
            Matcher chrome = Pattern.compile("Chrome/([0-9.]+)").matcher(userAgent);
            if (!chrome.find()) {
                return;
            }
            String fullVersion = chrome.group(1);
            String majorVersion = fullVersion.split("\\.")[0];
            Matcher android = Pattern.compile("Android\\s+([0-9.]+)").matcher(userAgent);
            String platformVersion = android.find() ? android.group(1) : Build.VERSION.RELEASE;
            Matcher modelMatcher = Pattern.compile("Android\\s+[^;]+;\\s*([^;)]+)\\)").matcher(userAgent);
            String model = modelMatcher.find() ? modelMatcher.group(1).trim() : Build.MODEL;
            int buildIndex = model.indexOf(" Build/");
            if (buildIndex > 0) {
                model = model.substring(0, buildIndex).trim();
            }

            List<UserAgentMetadata.BrandVersion> brands = new ArrayList<>();
            brands.add(new UserAgentMetadata.BrandVersion.Builder()
                    .setBrand("Chromium")
                    .setMajorVersion(majorVersion)
                    .setFullVersion(fullVersion)
                    .build());
            brands.add(new UserAgentMetadata.BrandVersion.Builder()
                    .setBrand("Google Chrome")
                    .setMajorVersion(majorVersion)
                    .setFullVersion(fullVersion)
                    .build());
            brands.add(new UserAgentMetadata.BrandVersion.Builder()
                    .setBrand("Not_A Brand")
                    .setMajorVersion("99")
                    .setFullVersion("99.0.0.0")
                    .build());

            boolean is64Bit = Build.SUPPORTED_64_BIT_ABIS.length > 0;
            UserAgentMetadata metadata = new UserAgentMetadata.Builder()
                    .setBrandVersionList(brands)
                    .setFullVersion(fullVersion)
                    .setPlatform("Android")
                    .setPlatformVersion(platformVersion)
                    .setArchitecture(is64Bit ? "arm64" : "arm")
                    .setModel(model)
                    .setMobile(true)
                    .setBitness(is64Bit ? 64 : 32)
                    .setWow64(false)
                    .setFormFactors(Collections.singletonList(UserAgentMetadata.FORM_FACTOR_MOBILE))
                    .build();
            WebSettingsCompat.setUserAgentMetadata(settings, metadata);
        } catch (Throwable t) {
            Log.w(TAG, "No se pudo configurar User-Agent Metadata", t);
        }
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            finishWithResult();
        }
    }

    @Override
    protected void onPause() {
        super.onPause();
        scheduleSnapshot();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, @Nullable Intent data) {
        if (requestCode == FILE_CHOOSER_REQUEST) {
            if (filePathCallback != null) {
                filePathCallback.onReceiveValue(
                        WebChromeClient.FileChooserParams.parseResult(resultCode, data));
                filePathCallback = null;
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    protected void onDestroy() {
        finished = true;
        mainHandler.removeCallbacks(snapshotRunnable);
        ioExecutor.shutdownNow();
        if (webView != null) {
            try {
                webView.destroy();
            } catch (Throwable ignored) {
                // Proceso en salida.
            }
            webView = null;
        }
        if (!closeCompleted) {
            // Cierre anómalo (swipe de la tarea, muerte del sistema): no se
            // envió el evento close, así que el plugin no va a consumir el
            // snapshot. Se borra el sandbox y los archivos con cookies.
            final Context appContext = getApplicationContext();
            final String profile = profileId;
            new Thread(() -> {
                ProfileBrowserStore.deleteProfileData(appContext, profile);
                if (profile != null && !profile.isEmpty()) {
                    //noinspection ResultOfMethodCallIgnored
                    ProfileBrowserStore.inputFile(appContext, profile).delete();
                    //noinspection ResultOfMethodCallIgnored
                    ProfileBrowserStore.outputFile(appContext, profile).delete();
                }
                mainHandler.postDelayed(
                        () -> Process.killProcess(Process.myPid()), 200L);
            }, "krakenges-browser-cleanup").start();
        }
        super.onDestroy();
    }

    @SuppressWarnings("deprecation")
    private static ResultReceiver getResultReceiver(Intent intent) {
        if (Build.VERSION.SDK_INT >= 33) {
            return intent.getParcelableExtra(EXTRA_RESULT_RECEIVER, ResultReceiver.class);
        }
        Parcelable parcelable = intent.getParcelableExtra(EXTRA_RESULT_RECEIVER);
        return parcelable instanceof ResultReceiver ? (ResultReceiver) parcelable : null;
    }

    private Button navButton(String text) {
        Button button = new Button(this);
        button.setText(text);
        button.setTextSize(TypedValue.COMPLEX_UNIT_SP, 20);
        button.setTextColor(Color.parseColor("#F8FAFC"));
        button.setBackgroundColor(Color.TRANSPARENT);
        button.setMinWidth(0);
        button.setMinimumWidth(0);
        button.setMinHeight(0);
        button.setMinimumHeight(0);
        button.setPadding(dp(10), 0, dp(10), 0);
        button.setLayoutParams(new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, dp(44)));
        return button;
    }

    private void hideKeyboard() {
        try {
            InputMethodManager imm = (InputMethodManager) getSystemService(Context.INPUT_METHOD_SERVICE);
            if (imm != null && urlInput != null) {
                imm.hideSoftInputFromWindow(urlInput.getWindowToken(), 0);
            }
        } catch (Throwable ignored) {
            // Sin teclado que ocultar.
        }
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private boolean canShowDialogs() {
        return !isFinishing() && !isDestroyed();
    }

    private final class BrowserClient extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            String scheme = uri.getScheme();
            if (scheme == null) {
                return false;
            }
            if (scheme.equals("http")) {
                statusView.setText("Kraken Ges no permite HTTP sin cifrar. Usa una URL HTTPS.");
                statusView.setVisibility(View.VISIBLE);
                progressBar.setVisibility(View.GONE);
                return true;
            }
            if (scheme.equals("https")
                    || scheme.equals("about")
                    || scheme.equals("data")
                    || scheme.equals("blob")) {
                return false;
            }
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, uri));
            } catch (Throwable ignored) {
                Toast.makeText(ProfileBrowserActivity.this,
                        "No se pudo abrir el enlace externo.", Toast.LENGTH_SHORT).show();
            }
            return true;
        }

        @Override
        public void onPageStarted(WebView view, String url, Bitmap favicon) {
            if (urlInput != null && !urlInput.hasFocus()) {
                urlInput.setText(url);
            }
            progressBar.setVisibility(View.VISIBLE);
            progressBar.setProgress(0);
            statusView.setVisibility(View.GONE);
            sendUrlChange(url);
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            pageLoaded = true;
            progressBar.setVisibility(View.GONE);
            if (urlInput != null && !urlInput.hasFocus()) {
                urlInput.setText(url);
            }
            scheduleSnapshot();
        }

        @Override
        public void doUpdateVisitedHistory(WebView view, String url, boolean isReload) {
            sendUrlChange(url);
            scheduleSnapshot();
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (request.isForMainFrame()) {
                statusView.setText("No se pudo cargar la página.");
                statusView.setVisibility(View.VISIBLE);
                progressBar.setVisibility(View.GONE);
            }
        }

        @Override
        public void onReceivedHttpError(WebView view, WebResourceRequest request,
                                        WebResourceResponse errorResponse) {
            if (request.isForMainFrame() && errorResponse != null
                    && errorResponse.getStatusCode() == 407) {
                statusView.setText(
                        "El proxy exige autenticación (407). El WebView no puede aplicarla.");
                statusView.setVisibility(View.VISIBLE);
                progressBar.setVisibility(View.GONE);
            }
        }
    }

    private final class BrowserChromeClient extends WebChromeClient {
        @Override
        public void onProgressChanged(WebView view, int newProgress) {
            progressBar.setProgress(newProgress);
            progressBar.setVisibility(newProgress >= 100 ? View.GONE : View.VISIBLE);
        }

        @Override
        public void onReceivedTitle(WebView view, String title) {
            if (!TextUtils.isEmpty(title)) {
                setTitle(title);
            }
        }

        @Override
        public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture,
                                      Message resultMsg) {
            // target=_blank se resuelve en el mismo WebView usando un WebView
            // temporal que solo intercepta la URL inicial del popup.
            final WebView temp = new WebView(ProfileBrowserActivity.this);
            temp.setWebViewClient(new WebViewClient() {
                @Override
                public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest request) {
                    String url = request.getUrl().toString();
                    if (webView != null) {
                        loadInWebView(url);
                    }
                    temp.destroy();
                    return true;
                }
            });
            WebView.WebViewTransport transport = (WebView.WebViewTransport) resultMsg.obj;
            transport.setWebView(temp);
            resultMsg.sendToTarget();
            return true;
        }

        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                         FileChooserParams params) {
            if (filePathCallback != null) {
                filePathCallback.onReceiveValue(null);
            }
            filePathCallback = callback;
            try {
                startActivityForResult(params.createIntent(), FILE_CHOOSER_REQUEST);
                return true;
            } catch (Throwable t) {
                filePathCallback = null;
                // Sin esto el <input type="file"> de la página queda colgado.
                try {
                    callback.onReceiveValue(null);
                } catch (Throwable ignored) {
                    // La página ya no espera el resultado.
                }
                return false;
            }
        }

        @Override
        public void onGeolocationPermissionsShowPrompt(String origin,
                                                       GeolocationPermissions.Callback callback) {
            callback.invoke(origin, false, false);
        }

        @Override
        public void onPermissionRequest(PermissionRequest request) {
            request.deny();
        }

        @Override
        public boolean onJsAlert(WebView view, String url, String message, JsResult result) {
            if (!canShowDialogs()) {
                result.cancel();
                return true;
            }
            new AlertDialog.Builder(ProfileBrowserActivity.this)
                    .setMessage(message)
                    .setPositiveButton("OK", (dialog, which) -> result.confirm())
                    .setOnCancelListener(dialog -> result.cancel())
                    .show();
            return true;
        }

        @Override
        public boolean onJsConfirm(WebView view, String url, String message, JsResult result) {
            if (!canShowDialogs()) {
                result.cancel();
                return true;
            }
            new AlertDialog.Builder(ProfileBrowserActivity.this)
                    .setMessage(message)
                    .setPositiveButton("OK", (dialog, which) -> result.confirm())
                    .setNegativeButton("Cancelar", (dialog, which) -> result.cancel())
                    .setOnCancelListener(dialog -> result.cancel())
                    .show();
            return true;
        }

        @Override
        public boolean onJsPrompt(WebView view, String url, String message, String defaultValue,
                                  JsPromptResult result) {
            if (!canShowDialogs()) {
                result.cancel();
                return true;
            }
            EditText input = new EditText(ProfileBrowserActivity.this);
            input.setSingleLine(true);
            input.setText(defaultValue != null ? defaultValue : "");
            new AlertDialog.Builder(ProfileBrowserActivity.this)
                    .setMessage(message)
                    .setView(input)
                    .setPositiveButton("OK", (dialog, which) -> result.confirm(input.getText().toString()))
                    .setNegativeButton("Cancelar", (dialog, which) -> result.cancel())
                    .setOnCancelListener(dialog -> result.cancel())
                    .show();
            return true;
        }

        @Override
        public boolean onConsoleMessage(android.webkit.ConsoleMessage consoleMessage) {
            // En release no se vuelca la consola de las páginas al logcat.
            if (Log.isLoggable(TAG, Log.DEBUG)) {
                Log.d(TAG, consoleMessage.message() + " @" + consoleMessage.lineNumber());
            }
            return true;
        }
    }

    private final class BrowserDownloadListener implements DownloadListener {
        @Override
        public void onDownloadStart(String url, String userAgent, String contentDisposition,
                                    String mimetype, long contentLength) {
            // DownloadManager corre en el proceso del sistema y NO usa el proxy
            // del WebView. Con proxy, la descarga saldría por la IP real.
            if (!TextUtils.isEmpty(proxyConfigured)) {
                Toast.makeText(ProfileBrowserActivity.this,
                        "Descargas deshabilitadas con proxy para no filtrar la IP real.",
                        Toast.LENGTH_LONG).show();
                return;
            }
            try {
                DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
                request.addRequestHeader("User-Agent", userAgent);
                String cookie = CookieManager.getInstance().getCookie(url);
                if (!TextUtils.isEmpty(cookie)) {
                    request.addRequestHeader("Cookie", cookie);
                }
                if (!TextUtils.isEmpty(mimetype)) {
                    request.setMimeType(mimetype);
                }
                String fileName = URLUtil.guessFileName(url, contentDisposition, mimetype);
                request.setTitle(fileName);
                request.setNotificationVisibility(
                        DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                request.setDestinationInExternalFilesDir(
                        ProfileBrowserActivity.this, Environment.DIRECTORY_DOWNLOADS, fileName);
                DownloadManager manager =
                        (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
                if (manager != null) {
                    manager.enqueue(request);
                    Toast.makeText(ProfileBrowserActivity.this,
                            "Descarga iniciada: " + fileName, Toast.LENGTH_LONG).show();
                }
            } catch (Throwable t) {
                Toast.makeText(ProfileBrowserActivity.this,
                        "No se pudo iniciar la descarga.", Toast.LENGTH_LONG).show();
            }
        }
    }

    private static final class CookieRecord {
        final String domain;
        final String name;
        final String value;
        final String path;
        final boolean secure;
        final boolean httpOnly;
        final int sameSite; // -1 sin especificar, 0 None, 1 Lax, 2 Strict

        CookieRecord(String domain, String name, String value, String path,
                     boolean secure, boolean httpOnly, int sameSite) {
            this.domain = domain;
            this.name = name;
            this.value = value != null ? value : "";
            this.path = TextUtils.isEmpty(path) ? "/" : path;
            this.secure = secure;
            this.httpOnly = httpOnly;
            this.sameSite = sameSite;
        }

        String url() {
            String host = domain.startsWith(".") ? domain.substring(1) : domain;
            return (secure ? "https://" : "http://") + host
                    + (path.startsWith("/") ? path : "/" + path);
        }

        String toSetCookieHeader() {
            StringBuilder builder = new StringBuilder();
            builder.append(name).append('=').append(value);
            if (domain.startsWith(".")) {
                builder.append("; Domain=").append(domain);
            }
            builder.append("; Path=").append(path);
            builder.append("; Max-Age=31536000");
            if (secure) {
                builder.append("; Secure");
            }
            if (httpOnly) {
                builder.append("; HttpOnly");
            }
            if (sameSite == 0 && secure) {
                builder.append("; SameSite=None");
            } else if (sameSite == 1) {
                builder.append("; SameSite=Lax");
            } else if (sameSite == 2) {
                builder.append("; SameSite=Strict");
            }
            return builder.toString();
        }

        JSONObject toJson() throws Exception {
            JSONObject object = new JSONObject();
            object.put("domain", domain);
            object.put("name", name);
            object.put("value", value);
            object.put("path", path);
            object.put("secure", secure);
            object.put("httpOnly", httpOnly);
            if (sameSite == 0 && secure) {
                object.put("sameSite", "None");
            } else if (sameSite == 1) {
                object.put("sameSite", "Lax");
            } else if (sameSite == 2) {
                object.put("sameSite", "Strict");
            }
            return object;
        }
    }
}
