// One-line logs on stdout/stderr (Fly collects both). Kept behind a tiny
// interface so tests can run silently.

export interface Logger {
  info(message: string): void;
  error(message: string, err?: unknown): void;
}

export const consoleLogger: Logger = {
  info: (message) => console.log(message),
  error: (message, err) => {
    if (err === undefined) console.error(message);
    else console.error(message, err instanceof Error ? (err.stack ?? err.message) : err);
  },
};

export const silentLogger: Logger = { info: () => {}, error: () => {} };
