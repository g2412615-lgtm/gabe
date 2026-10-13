import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The client is a plain single-page app. In development Vite serves it on
// :5173 and forwards /api to the Node server on :8787 (scripts/dev.mjs runs
// both); in production the Node server serves the built files itself.
export default defineConfig({
  plugins: [react()],
  root: ".",
  publicDir: "public",
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
    sourcemap: true,
    target: "es2020",
  },
  server: {
    port: 5173,
    strictPort: true,
    host: true,
    proxy: {
      "/api": { target: "http://localhost:8787", changeOrigin: false },
    },
  },
  test: {
    include: ["tests/server/**/*.test.ts", "tests/unit/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: "forks",
  },
} as any);
