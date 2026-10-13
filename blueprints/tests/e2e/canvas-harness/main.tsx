// Mounts BlueprintCanvas the way the editor does (selection, add → select →
// back to Move, live gestures applied to the circles, cancel restores) on a
// real rendered page, and exposes a small API on window.__bp for the
// Playwright spec: every callback is logged in order.

import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import BlueprintCanvas, { type CanvasGestureEvent, type CanvasHandle, type CanvasMode } from "../../../src/client/editor/canvas/BlueprintCanvas";
import type { View } from "../../../src/shared/geometry";
import type { CircleColor, CircleRow, PageRow } from "../../../src/shared/types";
import "../../../src/client/styles/tokens.css";
import "../../../src/client/styles/base.css";
import "../../../src/client/styles/components.css";
import "../../../src/client/styles/canvas.css";

export type HarnessEvent =
  | { t: "hover"; id: string | null; pointerType: string }
  | { t: "select"; id: string | null; how: string }
  | { t: "add"; x: number; y: number; r: number }
  | { t: "gesture"; e: CanvasGestureEvent }
  | { t: "view"; v: View }
  | { t: "cancelAdd" };

export interface HarnessApi {
  page: PageRow;
  events: HarnessEvent[];
  circles: CircleRow[];
  selectedId: string | null;
  mode: CanvasMode;
  canvas(): CanvasHandle | null;
  setMode(m: CanvasMode): void;
  setSelected(id: string | null): void;
  setLit(id: string | null): void;
  setRightInset(px: number): void;
  setCircles(c: CircleRow[]): void;
}

declare global {
  interface Window {
    __bp: HarnessApi;
  }
}

interface PageMeta {
  width: number;
  height: number;
  previewW: number;
  previewH: number;
  tileSize: number;
  minLevel: number;
  maxLevel: number;
}

const q = new URLSearchParams(location.search);

function circle(id: string, num: number, x: number, y: number, r: number, color: CircleColor): CircleRow {
  return { id, planId: "plan1", pageId: "page1", x, y, r, color, title: "", num, createdAt: 0, updatedAt: 0, deletedAt: null, rev: 1 };
}

// Spots on the fixture's "A-101 Seating bowl" sheet.
const INITIAL: CircleRow[] = q.get("empty")
  ? []
  : [
      circle("c1", 1, 0.5, 0.5, 0.05, "amber"), // the field
      circle("c2", 2, 0.811, 0.196, 0.025, "red"), // Gate A
      circle("c3", 3, 0.05, 0.95, 0.004, "blue"), // tiny, on the small print
      circle("c4", 4, 0.27, 0.35, 0.09, "green"), // big…
      circle("c5", 5, 0.29, 0.37, 0.015, "purple"), // …with a small one inside
      circle("c6", 0, 0.7, 0.75, 0.03, "amber"), // not saved yet: "•"
    ];

const api = { events: [] as HarnessEvent[] } as HarnessApi;
window.__bp = api;

function Harness({ page }: { page: PageRow }) {
  const [circles, setCircles] = useState(INITIAL);
  const [selectedId, setSelected] = useState<string | null>(q.get("select"));
  const [litId, setLit] = useState<string | null>(null);
  const [mode, setMode] = useState<CanvasMode>((q.get("mode") as CanvasMode) || "move");
  const [rightInset, setRightInset] = useState(Number(q.get("inset") || 0));
  const canvas = useRef<CanvasHandle>(null);
  const beforeGesture = useRef<CircleRow[] | null>(null);
  const seq = useRef(100);

  useEffect(() => {
    Object.assign(api, { page, circles, selectedId, mode, setMode, setSelected, setLit, setRightInset, setCircles, canvas: () => canvas.current });
  });

  const log = (e: HarnessEvent) => api.events.push(e);

  const onGesture = useCallback((e: CanvasGestureEvent) => {
    log({ t: "gesture", e });
    setCircles((cs) => {
      if (e.phase === "start") beforeGesture.current = cs;
      if (e.phase === "cancel") return beforeGesture.current ?? cs;
      if (e.phase === "end") beforeGesture.current = null;
      if (e.phase === "update" || e.phase === "end") {
        return cs.map((c) => (c.id !== e.id ? c : { ...c, ...(e.kind === "move" ? { x: e.x!, y: e.y! } : { r: e.r! }) }));
      }
      return cs;
    });
  }, []);

  return (
    <>
      <header className="hx-bar">Canvas harness · {page.width}×{page.height}</header>
      <main className="hx-stage">
        <BlueprintCanvas
          ref={canvas}
          page={page}
          circles={circles}
          selectedId={selectedId}
          litId={litId}
          mode={mode}
          initialView={q.get("view") ? (JSON.parse(q.get("view")!) as View) : null}
          rightInset={rightInset}
          onViewChange={(v) => log({ t: "view", v })}
          onHover={(id, pointerType) => log({ t: "hover", id, pointerType })}
          onSelect={(id, how) => {
            log({ t: "select", id, how });
            setSelected(id);
          }}
          onAdd={(c) => {
            log({ t: "add", ...c });
            const id = `n${++seq.current}`;
            setCircles((cs) => [...cs, circle(id, 0, c.x, c.y, c.r, "amber")]);
            setSelected(id);
            setMode("move");
          }}
          onGesture={onGesture}
          onCancelAdd={() => {
            log({ t: "cancelAdd" });
            setMode("move");
          }}
        />
      </main>
    </>
  );
}

async function main() {
  const meta = (await (await fetch("/__canvas/page.json")).json()) as PageMeta;
  const status = q.get("status") === "preview" ? "preview" : "ready";
  const page: PageRow = {
    id: "page1",
    planId: "plan1",
    sourceId: "src1",
    sourceIndex: 0,
    label: "A-101 Seating bowl",
    sortOrder: 1,
    status,
    error: null,
    width: meta.width,
    height: meta.height,
    previewW: meta.previewW,
    previewH: meta.previewH,
    tileSize: status === "ready" ? meta.tileSize : 0,
    maxLevel: status === "ready" ? meta.maxLevel : 0,
    minLevel: status === "ready" ? meta.minLevel : 0,
    tileFormat: status === "ready" ? "png" : "",
    assetKey: "k1",
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
    rev: 1,
  };
  const style = document.createElement("style");
  style.textContent = `
    body { overflow: hidden; }
    .hx-bar { position: fixed; left: 0; right: 0; top: 0; height: 48px; display: flex; align-items: center; padding: 0 16px;
      background: var(--surface); border-bottom: 1px solid var(--border-subtle); color: var(--text-2); font-size: 13px; }
    .hx-stage { position: fixed; left: 0; right: 0; top: 48px; bottom: 0; }
  `;
  document.head.append(style);
  createRoot(document.getElementById("root")!).render(<Harness page={page} />);
}

void main();
