// Bundles the Node server and its two workers (page renders, "Download PDF") into dist/server.
// npm packages stay external (node_modules ships in the image): mupdf loads
// its WebAssembly from its own folder and sharp has native binaries.
import { build } from "esbuild";

await build({
  entryPoints: { index: "src/server/index.ts", "render-worker": "src/server/render/worker.ts", "export-worker": "src/server/render/export-worker.ts" },
  outdir: "dist/server",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
  sourcemap: true,
  logLevel: "info",
});
