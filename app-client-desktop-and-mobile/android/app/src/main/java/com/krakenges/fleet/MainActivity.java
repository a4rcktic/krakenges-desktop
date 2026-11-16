package com.krakenges.fleet;

import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.content.pm.SigningInfo;
import android.os.Build;
import android.os.Bundle;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileReader;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.security.MessageDigest;

public class MainActivity extends BridgeActivity {

    // Expected SHA-256 fingerprint of official release.keystore (Anti-Repackaging Lock)
    //
    // La escribe tools/brand/apply.mjs desde `androidReleaseSha256` de
    // brand.config.json. Si no coincide con la keystore que firma el APK, la app
    // arranca, comprueba la firma, ve que no es la esperada y llama a
    // System.exit(0): abre y se cierra al instante, sin mensaje.
    //
    // Se obtiene con:
    //   keytool -exportcert -alias <alias> -keystore release.keystore | sha256sum
    private static final String OFFICIAL_RELEASE_SIGNATURE =
        "0000000000000000000000000000000000000000000000000000000000000000";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // Enforce active RASP runtime self-protection before initializing components
        if (isSecurityBreached()) {
            finishAffinity();
            System.exit(0);
            return;
        }

        registerPlugin(KrakenGesSessionPlugin.class);
        registerPlugin(ProfileBrowserPlugin.class);

        super.onCreate(savedInstanceState);

        // Depuración remota del WebView: apagada en release (bloquea chrome://inspect),
        // encendida solo en la build debug para poder medir la huella por adb.
        boolean debuggable = (getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        try {
            WebView.setWebContentsDebuggingEnabled(debuggable);
        } catch (Exception ignored) {}
    }

    private boolean isSecurityBreached() {
        boolean isDebuggable = (getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        if (isDebuggable) {
            // Development / Local test mode: allow testing via ADB while maintaining anti-hooking protection
            return isDynamicHookingActive();
        }
        return !isOfficialSignatureValid() || isDynamicHookingActive() || isDebuggerAttached();
    }

    /**
     * Verifies that the APK has not been decompiled, modified, or re-signed.
     */
    private boolean isOfficialSignatureValid() {
        try {
            Signature[] signatures;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                SigningInfo signingInfo = getPackageManager().getPackageInfo(
                    getPackageName(), PackageManager.GET_SIGNING_CERTIFICATES
                ).signingInfo;
                if (signingInfo.hasMultipleSigners()) {
                    signatures = signingInfo.getApkContentsSigners();
                } else {
                    signatures = signingInfo.getSigningCertificateHistory();
                }
            } else {
                signatures = getPackageManager().getPackageInfo(
                    getPackageName(), PackageManager.GET_SIGNATURES
                ).signatures;
            }

            if (signatures == null || signatures.length == 0) return false;

            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] digest = md.digest(signatures[0].toByteArray());

            StringBuilder sb = new StringBuilder();
            for (byte b : digest) {
                sb.append(String.format("%02X", b));
            }

            return OFFICIAL_RELEASE_SIGNATURE.equalsIgnoreCase(sb.toString());
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * Detects dynamic process injection tools such as Frida, Xposed, Substrate.
     */
    private boolean isDynamicHookingActive() {
        // 1. Check default Frida listening port
        try {
            Socket socket = new Socket();
            socket.connect(new InetSocketAddress("127.0.0.1", 27042), 80);
            socket.close();
            return true;
        } catch (Exception ignored) {}

        // 2. Scan memory maps for injected agent binaries
        try (BufferedReader reader = new BufferedReader(new FileReader("/proc/self/maps"))) {
            String line;
            while ((line = reader.readLine()) != null) {
                String lower = line.toLowerCase();
                if (lower.contains("frida") || lower.contains("xposed") || 
                    lower.contains("substrate") || lower.contains("gadget")) {
                    return true;
                }
            }
        } catch (Exception ignored) {}

        return false;
    }

    /**
     * Detects active debugging sessions (ptrace / GDB / LLDB / JDWP).
     */
    private boolean isDebuggerAttached() {
        if (android.os.Debug.isDebuggerConnected() || android.os.Debug.waitingForDebugger()) {
            return true;
        }

        try (BufferedReader reader = new BufferedReader(new FileReader("/proc/self/status"))) {
            String line;
            while ((line = reader.readLine()) != null) {
                if (line.startsWith("TracerPid:")) {
                    String pidStr = line.substring(10).trim();
                    int tracerPid = Integer.parseInt(pidStr);
                    if (tracerPid > 0) return true;
                    break;
                }
            }
        } catch (Exception ignored) {}

        return false;
    }
}
