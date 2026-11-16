package com.krakenges.fleet;

import android.content.Context;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Locale;

/**
 * Rutas y utilidades compartidas entre el plugin (proceso principal) y la
 * actividad de navegación (proceso :browser).
 *
 * El sufijo de {@link android.webkit.WebView#setDataDirectorySuffix(String)}
 * se deriva del profileId con SHA-256: es estable entre procesos, no contiene
 * separadores de ruta y no expone el identificador del perfil en el sistema de
 * archivos.
 */
final class ProfileBrowserStore {

    private static final String PREFIX = "krakenges_";
    private static final String SESSION_DIR = "browser_sessions";

    private ProfileBrowserStore() {
    }

    static String suffixFor(String profileId) {
        return PREFIX + sha256Hex(profileId).substring(0, 24);
    }

    static File sessionDir(Context context) {
        File dir = new File(context.getFilesDir(), SESSION_DIR);
        if (!dir.exists()) {
            //noinspection ResultOfMethodCallIgnored
            dir.mkdirs();
        }
        return dir;
    }

    static File inputFile(Context context, String profileId) {
        return new File(sessionDir(context), suffixFor(profileId) + "_in.json");
    }

    static File outputFile(Context context, String profileId) {
        return new File(sessionDir(context), suffixFor(profileId) + "_out.json");
    }

    static File webViewDataDir(Context context, String profileId) {
        // Chromium construye el nombre como WEBVIEW_DIR_BASENAME + "_" + sufijo
        // ("webview_<sufijo>") y Context.getDir() le antepone "app_".
        // Resultado real: <dataDir>/app_webview_<sufijo>.
        return new File(context.getApplicationInfo().dataDir,
                "app_webview_" + suffixFor(profileId));
    }

    static File webViewCacheDir(Context context, String profileId) {
        // Chromium usa <cacheDir>/webview_<sufijo>.
        return new File(context.getCacheDir(), "webview_" + suffixFor(profileId));
    }

    /**
     * Rutas que usó una versión intermedia con el cálculo incorrecto. Se
     * mantienen solo para limpiar restos de builds de desarrollo.
     */
    static File webViewCacheDirLegacy(Context context, String profileId) {
        return new File(context.getCacheDir(), suffixFor(profileId));
    }

    static File webViewCacheDirLegacyNested(Context context, String profileId) {
        return new File(context.getCacheDir(), "webview/" + suffixFor(profileId));
    }

    static void deleteProfileData(Context context, String profileId) {
        if (context == null || profileId == null || profileId.isEmpty()) {
            return;
        }
        deleteRecursively(webViewDataDir(context, profileId));
        deleteRecursively(webViewCacheDir(context, profileId));
        deleteRecursively(webViewCacheDirLegacy(context, profileId));
        deleteRecursively(webViewCacheDirLegacyNested(context, profileId));
    }

    static void deleteRecursively(File file) {
        if (file == null || !file.exists()) {
            return;
        }
        if (file.isDirectory()) {
            File[] children = file.listFiles();
            if (children != null) {
                for (File child : children) {
                    deleteRecursively(child);
                }
            }
        }
        //noinspection ResultOfMethodCallIgnored
        file.delete();
    }

    static String sha256Hex(String value) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] bytes = digest.digest(value.getBytes(StandardCharsets.UTF_8));
            StringBuilder builder = new StringBuilder(bytes.length * 2);
            for (byte b : bytes) {
                builder.append(String.format(Locale.US, "%02x", b));
            }
            return builder.toString();
        } catch (NoSuchAlgorithmException e) {
            // SHA-256 es obligatorio en Android; si falta, algo está muy roto.
            throw new IllegalStateException("SHA-256 no disponible", e);
        }
    }

    static void writeAtomically(File target, byte[] data) throws IOException {
        File parent = target.getParentFile();
        if (parent != null && !parent.exists()) {
            //noinspection ResultOfMethodCallIgnored
            parent.mkdirs();
        }
        File temp = new File(target.getAbsolutePath() + ".tmp");
        try (FileOutputStream out = new FileOutputStream(temp)) {
            out.write(data);
            out.flush();
            out.getFD().sync();
        }
        if (target.exists()) {
            //noinspection ResultOfMethodCallIgnored
            target.delete();
        }
        if (!temp.renameTo(target)) {
            try (FileInputStream in = new FileInputStream(temp);
                 FileOutputStream out = new FileOutputStream(target)) {
                byte[] buffer = new byte[8192];
                int read;
                while ((read = in.read(buffer)) != -1) {
                    out.write(buffer, 0, read);
                }
                out.flush();
                out.getFD().sync();
            }
            //noinspection ResultOfMethodCallIgnored
            temp.delete();
        }
    }
}
