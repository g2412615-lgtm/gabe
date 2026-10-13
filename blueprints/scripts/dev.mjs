// Local development: the API server on :8787 (restarts on change) and Vite on
// :5173 (hot reload, forwards /api). Open http://localhost:5173 — the
// password is "dev" unless APP_PASSWORD is set.
import { spawn } from "node:child_process";

const env = {
  ...process.env,
  PORT: process.env.PORT || "8787",
  DATA_DIR: process.env.DATA_DIR || "./data",
  APP_PASSWORD: process.env.APP_PASSWORD || (process.env.APP_PASSWORD_HASH ? "" : "dev"),
  NODE_ENV: "development",
};
const procs = [
  spawn("npx", ["tsx", "watch", "--clear-screen=false", "src/server/index.ts"], { stdio: "inherit", env }),
  spawn("npx", ["vite"], { stdio: "inherit", env }),
];
const stop = () => procs.forEach((p) => p.kill("SIGTERM"));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
procs.forEach((p) => p.on("exit", (code) => { if (code) { stop(); process.exit(code); } }));
