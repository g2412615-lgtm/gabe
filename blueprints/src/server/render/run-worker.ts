// Runs one render worker for one job — in its own Node process — and turns
// its life into a promise: resolves with the worker's final message once the
// process has exited; rejects on a crash, the timeout, or terminate().
//
// Why a process and not a worker thread: mupdf's WebAssembly heap (up to
// 2 GB) and sharp's pixel buffers sit outside any V8 limit, so one heavy
// page could grow the whole server until the kernel's OOM killer took it
// down — and the page was re-queued at every boot. The worker process asks
// the kernel to pick it first (oom_score_adj), so the server survives and
// the queue marks the page. SIGKILL also really stops libvips work, which
// terminating a thread could not: after a timeout nothing keeps running
// behind the next page's back.

import { fork } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { FinalMessage, WorkerMessage, WorkerTask } from "./protocol";

/**
 * In development/tests this module is src/server/render/run-worker.ts and the
 * worker is the .ts file next to it; in production everything is bundled
 * into dist/server/index.js and the worker is dist/server/render-worker.js.
 */
export const WORKER_FILE = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./worker.ts" : "./render-worker.js", import.meta.url));
/** The "Download PDF" worker, likewise (export-worker.ts / dist/server/export-worker.js). */
export const EXPORT_WORKER_FILE = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./export-worker.ts" : "./export-worker.js", import.meta.url));

/**
 * Node flags for the worker. Chosen here rather than inherited: the parent
 * may run under tsx, vitest or an inspector, none of which the worker wants.
 * The .ts worker runs through Node's own type stripping (it imports only
 * packages and types). The heap cap is for JS objects only.
 */
const WORKER_EXEC_ARGV = [
  "--disable-warning=ExperimentalWarning",
  "--max-old-space-size=512",
  ...(WORKER_FILE.endsWith(".ts") ? ["--experimental-strip-types"] : []),
];

/** A worker that has sent its answer gets this long to exit by itself before it is killed. */
const EXIT_GRACE_MS = 5_000;

export class WorkerTimeoutError extends Error {
  constructor() {
    super("render worker timed out");
  }
}

/** The worker died without answering: killed by the system (almost always out of memory) or crashed. */
export class WorkerCrashError extends Error {
  constructor(
    readonly code: number | null,
    readonly signal: NodeJS.Signals | null,
  ) {
    super(signal ? `render worker was killed (${signal})` : `render worker exited early (code ${code})`);
  }
}

/** terminate() was called. */
export class WorkerStoppedError extends Error {
  constructor() {
    super("render worker was stopped");
  }
}

export interface WorkerRun {
  /** Settles only after the worker process is gone. */
  promise: Promise<FinalMessage>;
  /** Kill the worker now. Resolves once the process is gone (the promise rejects unless the answer was already in). */
  terminate(): Promise<void>;
}

export function runWorker(task: WorkerTask, opts: { timeoutMs: number; onMessage?: (m: WorkerMessage) => void }): WorkerRun {
  const child = fork(task.task === "export" ? EXPORT_WORKER_FILE : WORKER_FILE, [JSON.stringify(task)], {
    execArgv: WORKER_EXEC_ARGV,
    // no stdin; the worker's stdout/stderr (crash traces) go to the server's log
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  // If memory runs out, the kernel should kill the worker, not the server.
  // Set here, before the worker has loaded anything (it repeats this itself
  // in case this write isn't allowed). Linux only; raising needs no privilege.
  try {
    if (child.pid) fs.writeFileSync(`/proc/${child.pid}/oom_score_adj`, "1000");
  } catch {
    /* not Linux */
  }
  let final: FinalMessage | null = null;
  let timedOut = false;
  let stopped = false;
  let exitTimer: NodeJS.Timeout | undefined;

  const kill = () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  };
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, opts.timeoutMs);

  // 'close' comes after the process exited and its IPC channel is drained,
  // so every message it sent has been seen by then.
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
    // always listened to: an unhandled 'error' would take the server down
    child.on("error", (error) => {
      // spawning failed (no process, so no 'close'); later errors (a failed kill) are followed by 'close'
      if (child.pid === undefined) resolve({ code: null, signal: null, error });
    });
  });

  child.on("message", (m: WorkerMessage) => {
    if (final || timedOut || stopped) return;
    if (m.type === "preview") {
      opts.onMessage?.(m);
      return;
    }
    final = m;
    clearTimeout(timer);
    exitTimer = setTimeout(kill, EXIT_GRACE_MS);
  });

  const promise = closed.then(({ code, signal, error }) => {
    clearTimeout(timer);
    clearTimeout(exitTimer);
    if (final) return final;
    if (error) throw error;
    if (timedOut) throw new WorkerTimeoutError();
    if (stopped) throw new WorkerStoppedError();
    throw new WorkerCrashError(code, signal);
  });
  promise.catch(() => {}); // callers may only care about terminate(); never an unhandled rejection

  return {
    promise,
    terminate: async () => {
      if (!final) stopped = true;
      kill();
      await closed;
    },
  };
}
