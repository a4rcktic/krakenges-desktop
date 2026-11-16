import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync } from "node:fs";

// La marca se lee del JSON y no de src/config/brand.generated.ts: ese archivo
// usa import.meta.env, que solo existe dentro de la app, no en este config.
const brand = JSON.parse(readFileSync(new URL("../brand.config.json", import.meta.url), "utf8"));

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    allowedHosts: true,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
    proxy: {
      // El backend de la marca (brand.config.json -> apiBaseUrl). Se usa su
      // origen: la ruta /api ya viene en la petición.
      "/api": {
        target: new URL(brand.apiBaseUrl).origin,
        changeOrigin: true,
        secure: false,
      },
    },
  },
}));
