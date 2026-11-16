import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/Common/ErrorBoundary";
import { applyBrandTheme } from "./config/branding";
import "./index.css";

// Iniciar configuración de marca y paleta de colores dinámicas
applyBrandTheme();

if (import.meta.env.PROD) {
  // Desactivar menú contextual para impedir "Inspeccionar elemento"
  document.addEventListener("contextmenu", (e) => e.preventDefault(), { capture: true });

  // Bloquear atajos de teclado de herramientas de desarrollo (F12, Ctrl+Shift+I, etc.)
  document.addEventListener("keydown", (e) => {
    if (
      e.key === "F12" ||
      (e.ctrlKey && e.shiftKey && ["I", "J", "C"].includes(e.key.toUpperCase())) ||
      (e.metaKey && e.altKey && ["I", "J", "C"].includes(e.key.toUpperCase())) ||
      (e.ctrlKey && ["U", "S"].includes(e.key.toUpperCase()))
    ) {
      e.preventDefault();
      e.stopPropagation();
      return false;
    }
  }, { capture: true });

  // Neutralizar consola en producción
  try {
    const noop = () => {};
    window.console.log = noop;
    window.console.info = noop;
    window.console.warn = noop;
    window.console.debug = noop;
  } catch (_) {}
}

import { PlatformProvider } from "./context/PlatformContext";
import { PlatformDevSwitcher } from "./components/Common/PlatformDevSwitcher";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <PlatformProvider>
        <App />
        <PlatformDevSwitcher />
      </PlatformProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
