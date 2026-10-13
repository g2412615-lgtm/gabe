// What every route module gets from createApp().

import type { PasswordCheck, LoginThrottle } from "./auth";
import type { ServerConfig } from "./config";
import type { Db } from "./db";
import type { RenderQueue } from "./render/queue";

export interface AppDeps {
  config: ServerConfig;
  db: Db;
  queue: RenderQueue;
  password: PasswordCheck;
  throttle: LoginThrottle;
  /** Cookie signing secret. */
  secret: string;
  /** Start rendering newly queued pages (no-op when rendering is switched off). */
  kickRender(): void;
}
