package com.krakenges.fleet;

import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.Message;
import android.os.Messenger;
import android.os.Parcelable;
import android.os.ResultReceiver;
import android.util.Log;
import android.webkit.WebView;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;

/**
 * Puente entre React y el navegador nativo aislado.
 *
 * El plugin vive en el proceso principal; la actividad
 * {@link ProfileBrowserActivity} vive en {@code :browser}. La comunicación es
 * unidireccional por {@link ResultReceiver} (actividad -> plugin) y
 * bidireccional para cerrar por {@link Messenger} (plugin -> actividad).
 */
@CapacitorPlugin(name = "ProfileBrowser")
public class ProfileBrowserPlugin extends Plugin {

    private static final String TAG = "KrakenGesBrowserPlugin";
    private static final long RESTART_GUARD_MS = 1200L;
    private static final long READY_TIMEOUT_MS = 15000L;
    private static final long CLOSE_TIMEOUT_MS = 20000L;

    private String activeProfileId;
    private Messenger activeMessenger;
    private boolean pendingClose;
    private PluginCall pendingCloseCall;
    private long lastCloseAt;

    @PluginMethod
    public void isAvailable(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("available", Build.VERSION.SDK_INT >= 28);
        ret.put("sdkInt", Build.VERSION.SDK_INT);
        try {
            android.content.pm.PackageInfo info = WebView.getCurrentWebViewPackage();
            if (info != null) {
                ret.put("webViewPackage", info.packageName);
                ret.put("webViewVersion", info.versionName);
            }
        } catch (Throwable ignored) {
            // El paquete de WebView no siempre está expuesto.
        }
        call.resolve(ret);
    }

    @PluginMethod
    public void open(PluginCall call) {
        final String profileId = call.getString("profileId");
        final String url = call.getString("url");
        if (Build.VERSION.SDK_INT < 28) {
            call.reject("Este navegador requiere Android 9 (API 28) o superior.");
            return;
        }
        if (profileId == null || profileId.isEmpty()) {
            call.reject("profileId es obligatorio.");
            return;
        }
        if (url == null || url.isEmpty()) {
            call.reject("url es obligatoria.");
            return;
        }
        if (profileId.equals(activeProfileId)) {
            // Ya está abierto: devolver éxito evita que el JS pierda el estado
            // del navegador activo al pulsar dos veces el mismo perfil.
            JSObject ret = new JSObject();
            ret.put("success", true);
            ret.put("profileId", profileId);
            ret.put("alreadyOpen", true);
            call.resolve(ret);
            return;
        }
        if (activeProfileId != null) {
            call.reject("Ya hay un perfil abierto. Ciérralo antes de abrir otro.");
            return;
        }

        long delay = Math.max(0L, RESTART_GUARD_MS - (System.currentTimeMillis() - lastCloseAt));
        Handler handler = new Handler(Looper.getMainLooper());
        handler.postDelayed(() -> startBrowser(call, profileId, url), delay);
    }

    private void startBrowser(PluginCall call, String profileId, String url) {
        try {
            Context context = getContext();
            File inputFile = ProfileBrowserStore.inputFile(context, profileId);
            JSArray cookiesArray = call.getArray("cookies");
            JSArray domainsArray = call.getArray("domains");
            JSONObject input = new JSONObject();
            input.put("profileId", profileId);
            input.put("cookies", cookiesArray != null ? new JSONArray(cookiesArray.toString()) : new JSONArray());
            input.put("domains", domainsArray != null ? new JSONArray(domainsArray.toString()) : new JSONArray());
            ProfileBrowserStore.writeAtomically(
                    inputFile, input.toString().getBytes(StandardCharsets.UTF_8));

            ArrayList<String> domains = new ArrayList<>();
            if (domainsArray != null) {
                for (int i = 0; i < domainsArray.length(); i++) {
                    String domain = domainsArray.getString(i);
                    if (domain != null && !domain.trim().isEmpty()) {
                        domains.add(domain.trim());
                    }
                }
            }

            Intent intent = new Intent(context, ProfileBrowserActivity.class);
            intent.putExtra(ProfileBrowserActivity.EXTRA_PROFILE_ID, profileId);
            intent.putExtra(ProfileBrowserActivity.EXTRA_URL, url);
            intent.putExtra(ProfileBrowserActivity.EXTRA_TITLE, call.getString("title", "Kraken Ges"));
            intent.putExtra(ProfileBrowserActivity.EXTRA_PROXY, call.getString("proxy"));
            intent.putExtra(ProfileBrowserActivity.EXTRA_USER_AGENT, call.getString("userAgent"));
            intent.putExtra(ProfileBrowserActivity.EXTRA_COOKIES_PATH, inputFile.getAbsolutePath());
            intent.putStringArrayListExtra(ProfileBrowserActivity.EXTRA_DOMAINS, domains);
            BrowserResultReceiver receiver =
                    new BrowserResultReceiver(new Handler(Looper.getMainLooper()));
            intent.putExtra(ProfileBrowserActivity.EXTRA_RESULT_RECEIVER, receiver);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);

            if (getActivity() == null) {
                call.reject("La actividad principal no está disponible.");
                return;
            }

            activeProfileId = profileId;
            activeMessenger = null;
            pendingClose = false;
            getActivity().startActivity(intent);

            JSObject ret = new JSObject();
            ret.put("success", true);
            ret.put("profileId", profileId);
            call.resolve(ret);

            // Si la actividad crashea antes de enviar "ready" o "error", el
            // plugin no puede quedarse bloqueado con activeProfileId puesto.
            final String startedProfileId = profileId;
            new Handler(Looper.getMainLooper()).postDelayed(() -> {
                if (startedProfileId.equals(activeProfileId) && activeMessenger == null) {
                    Log.w(TAG, "El navegador no envió 'ready' a tiempo");
                    JSObject data = new JSObject();
                    data.put("profileId", startedProfileId);
                    data.put("message", "El navegador no respondió a tiempo.");
                    notifyListeners("browserError", data);
                    clearActive();
                }
            }, READY_TIMEOUT_MS);
        } catch (Throwable t) {
            activeProfileId = null;
            activeMessenger = null;
            pendingClose = false;
            Log.e(TAG, "No se pudo iniciar el navegador", t);
            call.reject("No se pudo abrir el navegador: " + t.getMessage());
        }
    }

    @PluginMethod
    public void close(PluginCall call) {
        if (activeProfileId == null) {
            JSObject ret = new JSObject();
            ret.put("success", true);
            call.resolve(ret);
            return;
        }
        // Si ya había un cierre pendiente, se resuelve para no dejar colgada
        // la promesa anterior. La actividad solo puede cerrar una vez.
        if (pendingCloseCall != null) {
            JSObject previous = new JSObject();
            previous.put("success", true);
            pendingCloseCall.resolve(previous);
        }
        final PluginCall closeCall = call;
        pendingCloseCall = closeCall;

        if (activeMessenger != null) {
            try {
                activeMessenger.send(Message.obtain(null, ProfileBrowserActivity.MSG_CLOSE));
            } catch (Throwable t) {
                Log.w(TAG, "No se pudo enviar el cierre al navegador", t);
            }
        } else {
            pendingClose = true;
        }

        // Si la actividad murió sin avisar, no se deja la promesa colgada.
        new Handler(Looper.getMainLooper()).postDelayed(() -> {
            if (pendingCloseCall == closeCall) {
                JSObject ret = new JSObject();
                ret.put("success", true);
                closeCall.resolve(ret);
                pendingCloseCall = null;
                clearActive();
            }
        }, CLOSE_TIMEOUT_MS);
    }

    @PluginMethod
    public void getSessionResult(PluginCall call) {
        String profileId = call.getString("profileId");
        boolean consume = Boolean.TRUE.equals(call.getBoolean("consume", false));
        if (profileId == null || profileId.isEmpty()) {
            call.reject("profileId es obligatorio.");
            return;
        }
        try {
            File file = ProfileBrowserStore.outputFile(getContext(), profileId);
            if (!file.isFile()) {
                JSObject empty = new JSObject();
                empty.put("cookies", new JSArray());
                empty.put("count", 0);
                call.resolve(empty);
                return;
            }
            byte[] data = readFile(file);
            JSONObject root = new JSONObject(new String(data, StandardCharsets.UTF_8));
            JSONArray cookies = root.optJSONArray("cookies");
            JSObject ret = new JSObject();
            ret.put("cookies", cookies != null ? new JSArray(cookies.toString()) : new JSArray());
            ret.put("count", cookies != null ? cookies.length() : 0);
            String finalUrl = root.optString("finalUrl", null);
            if (finalUrl != null && !finalUrl.isEmpty()) {
                ret.put("finalUrl", finalUrl);
            }
            if (root.has("pageLoaded")) {
                ret.put("pageLoaded", root.optBoolean("pageLoaded", false));
            }
            long updatedAt = root.optLong("updatedAt", 0L);
            if (updatedAt > 0L) {
                ret.put("updatedAt", updatedAt);
            }
            if (consume) {
                //noinspection ResultOfMethodCallIgnored
                file.delete();
            }
            call.resolve(ret);
        } catch (Throwable t) {
            Log.w(TAG, "No se pudo leer el resultado de la sesión", t);
            call.reject("No se pudo leer la sesión: " + t.getMessage());
        }
    }

    @PluginMethod
    public void clearProfileData(PluginCall call) {
        String profileId = call.getString("profileId");
        if (profileId == null || profileId.isEmpty()) {
            call.reject("profileId es obligatorio.");
            return;
        }
        if (profileId.equals(activeProfileId)) {
            call.reject("Cierra el perfil antes de borrar sus datos.");
            return;
        }
        try {
            ProfileBrowserStore.deleteProfileData(getContext(), profileId);
            //noinspection ResultOfMethodCallIgnored
            ProfileBrowserStore.inputFile(getContext(), profileId).delete();
            //noinspection ResultOfMethodCallIgnored
            ProfileBrowserStore.outputFile(getContext(), profileId).delete();
            JSObject ret = new JSObject();
            ret.put("success", true);
            call.resolve(ret);
        } catch (Throwable t) {
            call.reject("No se pudo borrar el sandbox del perfil: " + t.getMessage());
        }
    }

    private void clearActive() {
        activeProfileId = null;
        activeMessenger = null;
        pendingClose = false;
        lastCloseAt = System.currentTimeMillis();
    }

    private static byte[] readFile(File file) throws Exception {
        try (FileInputStream in = new FileInputStream(file)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int read;
            while ((read = in.read(buffer)) != -1) {
                out.write(buffer, 0, read);
            }
            return out.toByteArray();
        }
    }

    private final class BrowserResultReceiver extends ResultReceiver {
        BrowserResultReceiver(Handler handler) {
            super(handler);
        }

        @Override
        protected void onReceiveResult(int resultCode, Bundle resultData) {
            if (resultData == null) {
                return;
            }
            String event = resultData.getString("event");
            String profileId = resultData.getString("profileId");
            if (event == null) {
                return;
            }
            switch (event) {
                case "ready": {
                    Parcelable parcelable = resultData.getParcelable("messenger");
                    if (parcelable instanceof Messenger) {
                        activeMessenger = (Messenger) parcelable;
                        if (pendingClose) {
                            pendingClose = false;
                            try {
                                activeMessenger.send(Message.obtain(null, ProfileBrowserActivity.MSG_CLOSE));
                            } catch (Throwable t) {
                                Log.w(TAG, "No se pudo enviar el cierre pendiente", t);
                            }
                        }
                    }
                    break;
                }
                case "urlChange": {
                    JSObject data = new JSObject();
                    data.put("profileId", profileId);
                    data.put("url", resultData.getString("url"));
                    notifyListeners("browserUrlChange", data);
                    break;
                }
                case "close": {
                    JSObject data = new JSObject();
                    data.put("profileId", profileId);
                    data.put("resultPath", resultData.getString("resultPath"));
                    notifyListeners("browserClose", data);
                    clearActive();
                    if (pendingCloseCall != null) {
                        JSObject ret = new JSObject();
                        ret.put("success", true);
                        pendingCloseCall.resolve(ret);
                        pendingCloseCall = null;
                    }
                    break;
                }
                case "error": {
                    JSObject data = new JSObject();
                    data.put("profileId", profileId);
                    data.put("message", resultData.getString("message"));
                    notifyListeners("browserError", data);
                    if (pendingCloseCall != null) {
                        pendingCloseCall.reject(resultData.getString("message", "Error del navegador"));
                        pendingCloseCall = null;
                    }
                    clearActive();
                    break;
                }
                default:
                    break;
            }
        }
    }
}
