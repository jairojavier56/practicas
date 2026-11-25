import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const backend = process.env.BACKEND_URL ?? "http://127.0.0.1:8080";

export default defineConfig({
  plugins: [react()],
  // React Flow + xterm.js ocupan ~650 KB: es normal para una app local, no avisar
  build: { chunkSizeWarningLimit: 1000 },
  server: {
    port: 5173,
    proxy: {
      "/api": backend,
      "/ws": { target: backend.replace(/^http/, "ws"), ws: true },
    },
  },
});
