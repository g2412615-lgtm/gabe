// Test doubles for the sync engine: an in-memory server that follows the
// same rules as POST /api/plans/:id/sync (src/server/sync.ts, SPEC §4), a
// network that can go offline / sign out / hold requests / lose replies, an
// in-memory localStorage and a page-lifecycle environment the tests drive.

import {
  circleColorOf,
  DEFAULT_CIRCLE_COLOR,
  DEFAULT_LEGEND,
  MAX_CIRCLE_R,
  MAX_COMMENT_CHARS,
  MAX_LABEL_CHARS,
  MAX_PLAN_NAME_CHARS,
  MAX_TITLE_CHARS,
  MIN_CIRCLE_R,
} from "../../src/shared/constants";
import { cleanLegend } from "../../src/shared/labels";
import { sameValue } from "../../src/shared/merge";
import {
  EDITABLE,
  type CircleRow,
  type CommentRow,
  type EntityKind,
  type PageRow,
  type PlanDoc,
  type PlanRow,
  type PlanRows,
  type SyncOp,
  type SyncRequest,
  type SyncResponse,
} from "../../src/shared/types";
import { ApiError } from "../../src/client/api";
import { createPlanStore } from "../../src/client/sync/store";
import type { PlanStore, PlanStoreOptions, StorageLike, SyncEnv, SyncEnvHandlers, SyncTransport } from "../../src/client/sync/types";

type Row = PlanRow | PageRow | CircleRow | CommentRow;
const clone = <T>(v: T): T => structuredClone(v);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
// eslint-disable-next-line no-control-regex
const strip = (s: string) => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
const cleanName = (v: unknown, max: number) => (typeof v === "string" ? strip(v).replace(/\s+/g, " ").trim().slice(0, max).trim() : "");

let idSeq = 0;
/** A plan's colour labels as the server starts them. */
const LEGEND_DEFAULTS = {
  legendGold: DEFAULT_LEGEND.gold,
  legendBlack: DEFAULT_LEGEND.black,
  legendRed: DEFAULT_LEGEND.red,
  legendBlue: DEFAULT_LEGEND.blue,
  legendGreen: DEFAULT_LEGEND.green,
};

export const testId = (prefix = "id") => `${prefix}-${(++idSeq).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** An in-memory copy of one plan on "the server", with the sync endpoint's rules. */
export class FakeServer {
  readonly planId: string;
  plan: PlanRow;
  pages = new Map<string, PageRow>();
  circles = new Map<string, CircleRow>();
  comments = new Map<string, CommentRow>();
  circleSeq = 0;
  /** Every op batch the server received (also from keepalive requests). */
  received: SyncOp[][] = [];

  constructor(opts: { pages?: number; name?: string } = {}) {
    const t = Date.now();
    this.planId = testId("plan");
    this.plan = {
      id: this.planId,
      name: opts.name ?? "Millrace Stadium — home opener",
      ...LEGEND_DEFAULTS,
      createdAt: t,
      updatedAt: t,
      deletedAt: null,
      rev: 1,
    };
    for (let i = 0; i < (opts.pages ?? 2); i++) this.addPage(`Page ${i + 1}`);
  }

  addPage(label: string, over: Partial<PageRow> = {}): PageRow {
    const t = Date.now();
    const maxSort = Math.max(0, ...[...this.pages.values()].map((p) => p.sortOrder));
    const page: PageRow = {
      id: testId("page"),
      planId: this.planId,
      sourceId: "src-1",
      sourceIndex: this.pages.size,
      label,
      sortOrder: this.pages.size ? maxSort + 1 : 1,
      status: "ready",
      error: null,
      width: 7200,
      height: 4800,
      previewW: 2048,
      previewH: 1365,
      tileSize: 512,
      maxLevel: 13,
      minLevel: 0,
      tileFormat: "png",
      assetKey: testId("asset"),
      createdAt: t,
      updatedAt: t,
      deletedAt: null,
      rev: 1,
      ...over,
    };
    this.pages.set(page.id, page);
    return page;
  }

  table(kind: EntityKind): Map<string, Row> {
    if (kind === "plan") return new Map([[this.plan.id, this.plan]]);
    return (kind === "page" ? this.pages : kind === "circle" ? this.circles : this.comments) as Map<string, Row>;
  }

  /** A change made "elsewhere" (the other device, the renderer): bumps rev like the real server. */
  edit<K extends "page" | "circle" | "comment" | "plan">(kind: K, id: string, patch: Partial<Row>) {
    const row = kind === "plan" ? this.plan : (this.table(kind).get(id) as Row);
    Object.assign(row, patch, { rev: row.rev + 1, updatedAt: Date.now() });
  }

  doc(): PlanDoc {
    if (this.plan.deletedAt !== null) throw new ApiError("That event plan doesn't exist any more.", 404);
    return clone({
      plan: this.plan,
      plans: [this.plan],
      pages: [...this.pages.values()].sort((a, b) => a.sortOrder - b.sortOrder),
      circles: [...this.circles.values()],
      comments: [...this.comments.values()],
      serverTime: Date.now(),
    });
  }

  private cleanField(f: string, v: unknown, current: unknown, now: number): unknown {
    switch (f) {
      case "deletedAt":
        if (v === null) return null;
        if (finite(v)) return current ?? now;
        return undefined;
      case "x":
      case "y":
        return finite(v) ? clamp(v, 0, 1) : undefined;
      case "r":
        return finite(v) ? clamp(v, MIN_CIRCLE_R, MAX_CIRCLE_R) : undefined;
      case "color":
        return circleColorOf(v); // as the server: an old name ("amber") counts as its new colour
      case "sortOrder":
        return finite(v) ? v : undefined;
      case "title":
        return typeof v === "string" ? strip(v).slice(0, MAX_TITLE_CHARS) : undefined;
      case "body":
        return typeof v === "string" ? strip(v).slice(0, MAX_COMMENT_CHARS) : undefined;
      case "label":
        return cleanName(v, MAX_LABEL_CHARS) || undefined;
      case "name":
        return cleanName(v, MAX_PLAN_NAME_CHARS) || undefined;
      case "legendGold":
      case "legendBlack":
      case "legendRed":
      case "legendBlue":
      case "legendGreen":
        return cleanLegend(v) ?? undefined;
    }
    return undefined;
  }

  sync(rawOps: SyncOp[]): SyncResponse {
    const ops = clone(rawOps);
    this.received.push(ops);
    const now = Date.now();
    const rejected: SyncResponse["rejected"] = [];
    const referenced = new Map<string, { kind: EntityKind; id: string }>();
    let changed = false;
    const order: EntityKind[] = ["plan", "page", "circle", "comment"];
    for (const op of order.flatMap((k) => ops.filter((o) => o.kind === k))) {
      const key = `${op.kind}:${op.id}`;
      const table = this.table(op.kind);
      const row = table.get(op.id) as Record<string, unknown> | undefined;
      if (!row) {
        if (op.kind === "plan" || op.kind === "page") {
          rejected.push({ kind: op.kind, id: op.id, reason: "That page no longer exists, so the change wasn't saved." });
          continue;
        }
        const d = op.data;
        if (op.kind === "circle") {
          if (typeof d.pageId !== "string" || !this.pages.has(d.pageId)) {
            rejected.push({ kind: "circle", id: op.id, reason: "That circle's page no longer exists, so the circle wasn't saved." });
            continue;
          }
          if (!finite(d.x) || !finite(d.y) || !finite(d.r)) {
            rejected.push({ kind: "circle", id: op.id, reason: "That circle's position or size wasn't a number, so it wasn't saved." });
            continue;
          }
          const num = ++this.circleSeq;
          this.circles.set(op.id, {
            id: op.id,
            planId: this.planId,
            pageId: d.pageId,
            x: clamp(d.x, 0, 1),
            y: clamp(d.y, 0, 1),
            r: clamp(d.r, MIN_CIRCLE_R, MAX_CIRCLE_R),
            color: circleColorOf(d.color) ?? DEFAULT_CIRCLE_COLOR,
            title: typeof d.title === "string" ? strip(d.title).slice(0, MAX_TITLE_CHARS) : "",
            num,
            createdAt: finite(d.createdAt) ? d.createdAt : now,
            updatedAt: now,
            deletedAt: finite(d.deletedAt) ? now : null,
            rev: 1,
          });
        } else {
          if (typeof d.circleId !== "string" || !this.circles.has(d.circleId)) {
            rejected.push({ kind: "comment", id: op.id, reason: "That comment's circle no longer exists, so the comment wasn't saved." });
            continue;
          }
          this.comments.set(op.id, {
            id: op.id,
            planId: this.planId,
            circleId: d.circleId,
            body: typeof d.body === "string" ? strip(d.body).slice(0, MAX_COMMENT_CHARS) : "",
            createdAt: finite(d.createdAt) ? d.createdAt : now,
            updatedAt: now,
            deletedAt: finite(d.deletedAt) ? now : null,
            rev: 1,
          });
        }
        referenced.set(key, { kind: op.kind, id: op.id });
        changed = true;
        continue;
      }
      referenced.set(key, { kind: op.kind, id: op.id });
      let any = false;
      for (const f of EDITABLE[op.kind] as readonly string[]) {
        if (!(f in op.data)) continue;
        if (op.base && sameValue(op.data[f], op.base[f])) continue;
        const v = this.cleanField(f, op.data[f], row[f], now);
        if (v === undefined || sameValue(v, row[f])) continue;
        row[f] = v;
        any = true;
      }
      if (any) {
        row.rev = (row.rev as number) + 1;
        row.updatedAt = now;
        changed = true;
      }
    }
    if (changed) this.plan.updatedAt = now;
    const rows: PlanRows = { plans: [], pages: [], circles: [], comments: [] };
    for (const { kind, id } of referenced.values()) {
      const r = clone(this.table(kind).get(id)!);
      if (kind === "plan") rows.plans.push(r as PlanRow);
      else if (kind === "page") rows.pages.push(r as PageRow);
      else if (kind === "circle") rows.circles.push(r as CircleRow);
      else rows.comments.push(r as CommentRow);
    }
    return { rows, rejected, serverTime: now };
  }
}

interface Held {
  ops: SyncOp[];
  keepalive: boolean;
  /** Apply on the server now (the request arrived) without answering yet. */
  arrive(): void;
  /** Answer (applying first if it hasn't arrived). */
  reply(): void;
  /** The connection drops: optionally after the server applied it (a lost reply). */
  fail(opts?: { applied?: boolean; status?: number }): void;
}

/** The network between one device and the fake server. */
export class FakeNet {
  /** null = working; a number = every call fails with that HTTP status (0 = no connection). */
  failWith: number | null = null;
  /** Hold sync requests until the test answers them (see `held`). */
  hold = false;
  held: Held[] = [];
  /** The server applies the next sync request but the reply never arrives. */
  loseNextReply = false;
  calls = { getPlan: 0, sync: 0, getPages: 0, me: 0 };
  syncs: { ops: SyncOp[]; keepalive: boolean }[] = [];
  signedIn = true;

  constructor(readonly server: FakeServer) {}

  private check() {
    if (this.failWith !== null) throw new ApiError(this.failWith === 0 ? "No connection — your changes are kept on this device." : `Failed with ${this.failWith}.`, this.failWith);
    if (!this.signedIn) throw new ApiError("You've been signed out — sign in again to keep working.", 401);
  }

  readonly transport: SyncTransport = {
    getPlan: async (planId) => {
      this.calls.getPlan++;
      await Promise.resolve();
      this.check();
      if (planId !== this.server.planId) throw new ApiError("That event plan doesn't exist any more.", 404);
      return this.server.doc();
    },
    getPages: async () => {
      this.calls.getPages++;
      await Promise.resolve();
      this.check();
      return clone({ pages: [...this.server.pages.values()] });
    },
    me: async () => {
      this.calls.me++;
      await Promise.resolve();
      this.check();
      return { ok: true };
    },
    sync: (_planId: string, body: SyncRequest, opts?: { keepalive?: boolean }) => {
      this.calls.sync++;
      const ops = clone(body.ops);
      const keepalive = !!opts?.keepalive;
      this.syncs.push({ ops, keepalive });
      if (this.hold) {
        return new Promise<SyncResponse>((resolve, reject) => {
          let res: SyncResponse | null = null;
          const arrive = () => {
            if (!res) res = this.server.sync(ops);
          };
          this.held.push({
            ops,
            keepalive,
            arrive,
            reply: () => {
              arrive();
              resolve(clone(res!));
            },
            fail: ({ applied = false, status = 0 } = {}) => {
              if (applied) arrive();
              reject(new ApiError("No connection — your changes are kept on this device.", status));
            },
          });
        });
      }
      return (async () => {
        await Promise.resolve();
        this.check();
        const res = this.server.sync(ops);
        if (this.loseNextReply) {
          this.loseNextReply = false;
          throw new ApiError("No connection — your changes are kept on this device.", 0);
        }
        return clone(res);
      })();
    },
  };

  /** The ops of every sync request, flattened. */
  sentOps(): SyncOp[] {
    return this.syncs.flatMap((s) => s.ops);
  }
}

export class MemoryStorage implements StorageLike {
  data = new Map<string, string>();
  failWrites = false;
  writes = 0;
  get length() {
    return this.data.size;
  }
  key(i: number) {
    return [...this.data.keys()][i] ?? null;
  }
  getItem(key: string) {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    if (this.failWrites) throw new Error("QuotaExceededError");
    this.writes++;
    this.data.set(key, value);
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
  json(key: string): any {
    const v = this.data.get(key);
    return v ? JSON.parse(v) : null;
  }
}

export class FakeEnv implements SyncEnv {
  visible = true;
  /** What navigator.onLine would say (false: requests can't leave the device). */
  connected = true;
  handlers: SyncEnvHandlers | null = null;
  isVisible() {
    return this.visible;
  }
  isOnline() {
    return this.connected;
  }
  listen(h: SyncEnvHandlers) {
    this.handlers = h;
    return () => {
      this.handlers = null;
    };
  }
  hide() {
    this.visible = false;
    this.handlers?.hidden();
  }
  show() {
    this.visible = true;
    this.handlers?.visible();
  }
  online() {
    this.handlers?.online();
  }
}

export interface Device {
  store: PlanStore;
  net: FakeNet;
  storage: MemoryStorage;
  env: FakeEnv;
  toasts: { message: string; kind?: string }[];
}

/** One device (a browser tab) editing `server`'s plan. */
export function device(server: FakeServer, opts: { storage?: MemoryStorage; net?: FakeNet; options?: Partial<PlanStoreOptions> } = {}): Device {
  const net = opts.net ?? new FakeNet(server);
  const storage = opts.storage ?? new MemoryStorage();
  const env = new FakeEnv();
  const toasts: { message: string; kind?: string }[] = [];
  const store = createPlanStore(server.planId, {
    transport: net.transport,
    storage,
    env,
    notify: (message, kind) => toasts.push({ message, kind }),
    ...opts.options,
  });
  return { store, net, storage, env, toasts };
}

/** Let pending promise callbacks run (fake timers stay where they are). */
export async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
