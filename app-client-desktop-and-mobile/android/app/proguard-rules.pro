# Kraken Ges Fleet — Advanced ProGuard / R8 Anti-Decompilation Rules

# Strip source file names and line numbers from compiled bytecode
-repackageclasses com.krakenges.fleet.sec
-allowaccessmodification
-dontusemixedcaseclassnames
-renamesourcefileattribute KrakenGes
-keepattributes !SourceFile,!LineNumberTable,*Annotation*

# Preserve Capacitor Bridge & Plugins
-keepclassmembers class * {
    @org.webkit.xwalk.core.JavascriptInterface <methods>;
    @android.webkit.JavascriptInterface <methods>;
}
-keep class com.getcapacitor.** { *; }
-keep interface com.getcapacitor.** { *; }
-keep public class * extends com.getcapacitor.Plugin
-keep public class * extends com.getcapacitor.BridgeActivity
-keep class com.capgo.** { *; }
-keep class androidx.appcompat.** { *; }
-keep class androidx.core.** { *; }
-keep class androidx.coordinatorlayout.** { *; }

# Suppress harmless warnings
-dontwarn **
