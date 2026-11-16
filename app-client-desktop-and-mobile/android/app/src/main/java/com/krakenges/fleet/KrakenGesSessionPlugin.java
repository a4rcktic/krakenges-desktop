package com.krakenges.fleet;

import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.os.Build;
import android.provider.Settings;
import android.webkit.CookieManager;
import android.webkit.WebView;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.io.File;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

import androidx.webkit.Profile;
import androidx.webkit.ProfileStore;
import androidx.webkit.WebViewFeature;
import android.util.Log;

@CapacitorPlugin(name = "KrakenGesSession")
public class KrakenGesSessionPlugin extends Plugin {

    private static final String TAG = "KrakenGesSession";
    private static final String PROFILE_PREFIX = "krakenges_";

    /** True si el WebView del dispositivo soporta perfiles aislados de Chromium. */
    private boolean isProfileIsolationAvailable() {
        return WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE);
    }

    /**
     * CookieManager del perfil. NUNCA cae al CookieManager global: si el
     * aislamiento no está disponible devuelve null y el llamante rechaza la
     * operación. El fallback silencioso anterior compartía cookies entre perfiles.
     */
    private CookieManager getCookieManagerForProfile(String profileId) {
        if (profileId == null || profileId.isEmpty() || !isProfileIsolationAvailable()) {
            return null;
        }
        try {
            Profile profile = ProfileStore.getInstance().getOrCreateProfile(PROFILE_PREFIX + profileId);
            return profile.getCookieManager();
        } catch (Throwable t) {
            Log.w(TAG, "Could not get Profile CookieManager: " + t.getMessage());
            return null;
        }
    }

    private void rejectIfNoIsolation(PluginCall call) {
        call.reject(
            "Aislamiento de sesión no disponible: este WebView no soporta MULTI_PROFILE. " +
            "Actualiza Android System WebView; la operación se rechaza para no compartir cookies entre perfiles."
        );
    }

    /**
     * Flushes CookieManager in-memory cookies to disk (SQLite database).
     */
    @PluginMethod
    public void flushSession(PluginCall call) {
        String profileId = call != null ? call.getString("profileId") : null;
        CookieManager cm = getCookieManagerForProfile(profileId);
        if (cm == null) {
            rejectIfNoIsolation(call);
            return;
        }
        try {
            cm.flush();
            JSObject ret = new JSObject();
            ret.put("success", true);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Error flushing session: " + e.getMessage());
        }
    }

    /**
     * Clears cookies and session state for the specified profile without destroying its persistent sandbox.
     */
    @PluginMethod
    public void clearAllSessionData(PluginCall call) {
        if (getActivity() == null) {
            call.resolve();
            return;
        }

        final String profileId = call != null ? call.getString("profileId") : null;
        final CookieManager cm = getCookieManagerForProfile(profileId);
        if (cm == null) {
            rejectIfNoIsolation(call);
            return;
        }

        getActivity().runOnUiThread(() -> {
            try {
                // Solo se limpia el CookieManager del perfil. Nunca el global ni
                // WebStorage/WebViewDatabase, que son compartidos por todos los
                // perfiles y provocaban borrados cruzados.
                cm.removeAllCookies(c1 -> {
                    cm.removeSessionCookies(s1 -> {
                        cm.flush();
                        call.resolve();
                    });
                });
            } catch (Exception e) {
                call.reject("Error clearing session data: " + e.getMessage());
            }
        });
    }

    /**
     * Injects an array of cookies directly into the Profile's isolated CookieManager.
     */
    @PluginMethod
    public void injectCookies(PluginCall call) {
        try {
            JSArray cookies = call.getArray("cookies");
            String profileId = call.getString("profileId");
            if (cookies != null && cookies.length() > 0) {
                CookieManager cm = getCookieManagerForProfile(profileId);
                if (cm == null) {
                    rejectIfNoIsolation(call);
                    return;
                }
                cm.setAcceptCookie(true);

                for (int i = 0; i < cookies.length(); i++) {
                    try {
                        JSONObject c = cookies.getJSONObject(i);
                        String domain = c.optString("domain", "").trim();
                        String name = c.optString("name", "").trim();
                        String value = c.optString("value", "");
                        String path = c.optString("path", "/");
                        if (path.isEmpty()) path = "/";
                        boolean secure = c.optBoolean("secure", false);
                        boolean httpOnly = c.optBoolean("httpOnly", false);

                        if (domain.isEmpty() || name.isEmpty()) continue;

                        String cleanDomain = domain.startsWith(".") ? domain.substring(1) : domain;
                        String scheme = secure ? "https://" : "http://";
                        String url = scheme + cleanDomain + (path.startsWith("/") ? path : "/" + path);

                        StringBuilder sb = new StringBuilder();
                        sb.append(name).append("=").append(value);
                        sb.append("; Domain=").append(domain);
                        sb.append("; Path=").append(path);
                        sb.append("; Max-Age=31536000"); // 1 year persistence for saved cookies
                        if (secure) sb.append("; Secure");
                        if (httpOnly) sb.append("; HttpOnly");

                        cm.setCookie(url, sb.toString());

                        if (domain.startsWith(".")) {
                            cm.setCookie(scheme + cleanDomain, sb.toString());
                        }
                    } catch (Exception ignored) {}
                }
                cm.flush();
            }
            call.resolve();
        } catch (Exception e) {
            call.reject("Error injecting cookies: " + e.getMessage());
        }
    }

    /**
     * Discovers ALL cookies across ALL domains currently stored in Android WebView,
     * by querying both explicit domains and Chromium's underlying SQLite database.
     */
    @PluginMethod
    public void getAllCookies(PluginCall call) {
        try {
            String profileId = call != null ? call.getString("profileId") : null;
            CookieManager cm = getCookieManagerForProfile(profileId);
            if (cm == null) {
                rejectIfNoIsolation(call);
                return;
            }
            cm.flush();

            Set<String> discoveredHosts = new HashSet<>();

            // 1. Explicit domains passed from client
            JSArray clientDomains = call != null ? call.getArray("domains") : null;
            if (clientDomains != null) {
                for (int i = 0; i < clientDomains.length(); i++) {
                    String d = clientDomains.getString(i).trim();
                    if (!d.isEmpty()) discoveredHosts.add(d);
                }
            }

            // 2. Discover all domains from WebView's internal SQLite database
            File appDir = getContext().getApplicationInfo().dataDir != null
                ? new File(getContext().getApplicationInfo().dataDir)
                : getContext().getFilesDir().getParentFile();

            // Solo la base de datos del perfil. Antes se añadían también las
            // rutas globales de app_webview/, lo que permitía leer cookies de
            // otros perfiles.
            java.util.List<File> candidates = new java.util.ArrayList<>();
            File profileDir = new File(appDir, "app_webview/" + PROFILE_PREFIX + profileId);
            candidates.add(new File(profileDir, "Cookies"));
            candidates.add(new File(profileDir, "Default/Cookies"));
            candidates.add(new File(profileDir, "Network/Cookies"));
            candidates.add(new File(profileDir, "Default/Network/Cookies"));

            for (File dbFile : candidates) {
                if (dbFile.exists()) {
                    SQLiteDatabase db = null;
                    Cursor cursor = null;
                    try {
                        db = SQLiteDatabase.openDatabase(dbFile.getAbsolutePath(), null, SQLiteDatabase.OPEN_READONLY);
                        cursor = db.rawQuery("SELECT DISTINCT host_key FROM cookies", null);
                        if (cursor != null && cursor.moveToFirst()) {
                            do {
                                String host = cursor.getString(0);
                                if (host != null && !host.trim().isEmpty()) {
                                    discoveredHosts.add(host.trim());
                                }
                            } while (cursor.moveToNext());
                        }
                    } catch (Exception ignored) {
                    } finally {
                        if (cursor != null) cursor.close();
                        if (db != null) db.close();
                    }
                }
            }

            // 3. Harvest cookies via CookieManager for all discovered hosts
            Map<String, JSONObject> dedup = new HashMap<>();
            for (String host : discoveredHosts) {
                String cleanDomain = host.startsWith(".") ? host.substring(1) : host;
                String[] testUrls = new String[] {
                    "https://" + cleanDomain,
                    "https://www." + cleanDomain,
                    "http://" + cleanDomain,
                    "http://www." + cleanDomain
                };

                for (String u : testUrls) {
                    String cookieHeader = cm.getCookie(u);
                    if (cookieHeader != null && !cookieHeader.trim().isEmpty()) {
                        String[] pairs = cookieHeader.split(";\\s*");
                        for (String pair : pairs) {
                            String[] kv = pair.split("=", 2);
                            if (kv.length == 2 && !kv[0].trim().isEmpty()) {
                                String name = kv[0].trim();
                                String val = kv[1].trim();
                                String dedupKey = cleanDomain.toLowerCase() + "|" + name;

                                if (!dedup.containsKey(dedupKey)) {
                                    JSONObject item = new JSONObject();
                                    item.put("domain", host.startsWith(".") ? host : "." + host);
                                    item.put("name", name);
                                    item.put("value", val);
                                    item.put("path", "/");
                                    item.put("secure", u.startsWith("https"));
                                    dedup.put(dedupKey, item);
                                }
                            }
                        }
                    }
                }
            }

            JSArray result = new JSArray();
            for (JSONObject item : dedup.values()) {
                result.put(item);
            }

            JSArray hostsArray = new JSArray();
            for (String h : discoveredHosts) {
                hostsArray.put(h);
            }

            JSObject ret = new JSObject();
            ret.put("cookies", result);
            ret.put("count", result.length());
            ret.put("discoveredHosts", hostsArray);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Error retrieving cookies: " + e.getMessage());
        }
    }

    /**
     * Deletes the isolated Chromium profile directory and wipes all its persistent data from disk.
     */
    @PluginMethod
    public void deleteProfile(PluginCall call) {
        String profileId = call != null ? call.getString("profileId") : null;
        if (profileId == null || profileId.isEmpty() || !isProfileIsolationAvailable()) {
            rejectIfNoIsolation(call);
            return;
        }
        try {
            boolean deleted = ProfileStore.getInstance().deleteProfile(PROFILE_PREFIX + profileId);
            JSObject ret = new JSObject();
            ret.put("success", deleted);
            call.resolve(ret);
        } catch (IllegalStateException e) {
            // ProfileStore no permite borrar un perfil cargado en memoria. No
            // es fatal: el sandbox nuevo se borra por otra vía. Se devuelve un
            // resultado explícito en vez de reventar la promesa.
            Log.w(TAG, "Perfil ProfileStore cargado en memoria; no se puede borrar: " + e.getMessage());
            JSObject ret = new JSObject();
            ret.put("success", false);
            ret.put("reason", "loaded_in_memory");
            call.resolve(ret);
        } catch (Throwable t) {
            Log.w(TAG, "Error deleting profile: " + t.getMessage());
            JSObject ret = new JSObject();
            ret.put("success", false);
            ret.put("reason", "delete_failed");
            call.resolve(ret);
        }
    }

    /**
     * Backward-compatible getCookiesForDomains.
     */
    @PluginMethod
    public void getCookiesForDomains(PluginCall call) {
        getAllCookies(call);
    }

    /**
     * Audits the real device environment, WebView package/version, and storage sandboxes.
     */
    @PluginMethod
    public void getSystemInfo(PluginCall call) {
        try {
            JSObject info = new JSObject();

            // 1. Real WebView Engine & Version
            String webViewVersion = "Unknown";
            String webViewPackage = "Unknown";
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    PackageInfo p = WebView.getCurrentWebViewPackage();
                    if (p != null) {
                        webViewVersion = p.versionName;
                        webViewPackage = p.packageName;
                    }
                }
                if ("Unknown".equals(webViewVersion)) {
                    PackageManager pm = getContext().getPackageManager();
                    String[] candidates = {"com.google.android.webview", "com.android.webview", "com.google.android.trichromelibrary"};
                    for (String pkg : candidates) {
                        try {
                            PackageInfo pi = pm.getPackageInfo(pkg, 0);
                            webViewVersion = pi.versionName;
                            webViewPackage = pkg;
                            break;
                        } catch (Exception ignored) {}
                    }
                }
            } catch (Exception ignored) {}

            info.put("webViewVersion", webViewVersion);
            info.put("webViewPackage", webViewPackage);

            // 2. Hardware / OS Specs
            info.put("manufacturer", Build.MANUFACTURER);
            info.put("model", Build.MODEL);
            info.put("brand", Build.BRAND);
            info.put("device", Build.DEVICE);
            info.put("androidRelease", Build.VERSION.RELEASE);
            info.put("sdkInt", Build.VERSION.SDK_INT);

            // 3. Storage Sandbox Verification
            boolean sandboxReady = false;
            long freeStorageMb = 0;
            try {
                File filesDir = getContext().getFilesDir();
                File sandboxDir = new File(filesDir, "profiles");
                if (!sandboxDir.exists()) {
                    sandboxDir.mkdirs();
                }
                File testFile = new File(sandboxDir, ".sandbox_probe");
                if (testFile.createNewFile()) {
                    sandboxReady = true;
                    testFile.delete();
                } else {
                    sandboxReady = sandboxDir.canWrite();
                }
                freeStorageMb = filesDir.getFreeSpace() / (1024 * 1024);
            } catch (Exception ignored) {}

            info.put("sandboxReady", sandboxReady);
            info.put("freeStorageMb", freeStorageMb);
            info.put("cpuCores", Runtime.getRuntime().availableProcessors());
            info.put("maxMemoryMb", Runtime.getRuntime().maxMemory() / (1024 * 1024));

            // 4. Modern Chromium Anti-Ban Capabilities
            info.put("multiProfileSupported", WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE));
            info.put("proxyOverrideSupported", WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE));
            info.put("requestedWithSuppressionSupported", WebViewFeature.isFeatureSupported(WebViewFeature.REQUESTED_WITH_HEADER_ALLOW_LIST));
            info.put("userAgentMetadataSupported", WebViewFeature.isFeatureSupported(WebViewFeature.USER_AGENT_METADATA));

            call.resolve(info);
        } catch (Exception e) {
            call.reject("Error reading system info: " + e.getMessage());
        }
    }

    /**
     * Opens Android Airplane / Wireless settings to facilitate rapid 4G/5G IP address rotation.
     */
    @PluginMethod
    public void openAirplaneSettings(PluginCall call) {
        try {
            if (getActivity() != null) {
                Intent intent = new Intent(Settings.ACTION_AIRPLANE_MODE_SETTINGS);
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getActivity().startActivity(intent);
            }
            call.resolve();
        } catch (Exception e) {
            try {
                if (getActivity() != null) {
                    Intent fallback = new Intent(Settings.ACTION_WIRELESS_SETTINGS);
                    fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    getActivity().startActivity(fallback);
                }
                call.resolve();
            } catch (Exception e2) {
                call.reject("Could not open airplane/wireless settings: " + e2.getMessage());
            }
        }
    }
}
