import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "apps/desktop",
  plugins: [react()],
  build: {
    outDir: "../../dist/desktop",
    emptyOutDir: true
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:4317",
      "/events": { target: "http://127.0.0.1:4317", ws: true }
    }
  }
});
