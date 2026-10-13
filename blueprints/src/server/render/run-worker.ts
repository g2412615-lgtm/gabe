// Starts one render worker for one job and turns its life into a promise:
// resolves with the worker's final message, rejects on a crash, an early
// exit or the timeout (the worker is terminated then).

import { Worker } from "node:worker_threads";
import type { FinalMessage, WorkerMessage, WorkerTask } from "./protocol";

/**
 * In development/tests this module is src/server/render/run-worker.ts and the
 * worker is the .ts file next to it; in production everything is bundled
 * into dist/server/index.js and the worker is dist/server/render-worker.js.
 */
export const WORKER_URL = new URL(import.meta.url.endsWith(".ts") ? "./worker.ts" : "./render-worker.js", import.meta.url);

export class WorkerTimeoutError extends Error {
  constructor() {
    super("render worker timed out");
  }
}

export interface WorkerRun {
  promise: Promise<FinalMessage>;
  /** Stop the worker now (shutdown). The promise rejects. */
  terminate(): Promise<void>;
}

export function runWorker(task: WorkerTask, opts: { timeoutMs: number; onMessage?: (m: WorkerMessage) => void }): WorkerRun {
  const worker = new Worker(WORKER_URL, {
    workerData: task,
    // JS heap only — mupdf's wasm memory and sharp's pixel buffers live outside it
    resourceLimits: { maxOldGenerationSizeMb: 512 },
  });
  let settled = false;
  let timer: NodeJS.Timeout | undefined;

  const promise = new Promise<FinalMessage>((resolve, reject) => {
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    timer = setTimeout(() => {
      finish(() => reject(new WorkerTimeoutError()));
      void worker.terminate();
    }, opts.timeoutMs);
    worker.on("message", (m: WorkerMessage) => {
      if (settled) return;
      if (m.type === "preview") {
        opts.onMessage?.(m);
        return;
      }
      finish(() => resolve(m));
      // The job is over; make sure the thread (and its wasm heap) goes away now.
      void worker.terminate();
    });
    worker.on("error", (err) => finish(() => reject(err)));
    worker.on("exit", (code) => finish(() => reject(new Error(`render worker exited early (code ${code})`))));
  });

  return {
    promise,
    terminate: async () => {
      await worker.terminate();
    },
  };
}
