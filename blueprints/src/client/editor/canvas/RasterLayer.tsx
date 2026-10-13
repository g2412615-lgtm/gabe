// The blueprint itself: a white sheet (screen space, so its shadow keeps a
// constant size), the preview image stretched to the page (always there, so
// something shows instantly) and, when the screen needs more detail than the
// preview has, the deep-zoom tiles of the matching level.
//
// Level changes never flash blurry: the last level that fully covered the
// screen stays mounted underneath until the new level's tiles in view have
// all loaded.

import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type SyntheticEvent } from "react";
import { pickLevel, type View } from "../../../shared/geometry";
import type { PageRow } from "../../../shared/types";
import { assetUrl } from "../../api";
import { visibleTiles, type Size, type TileBox } from "./viewMath";

/** How many finished tiles to remember (so one coming back into view skips the fade). */
const DONE_MEMORY = 3000;

type OnDone = (id: string, ok: boolean, img: HTMLImageElement) => void;

const tileId = (page: PageRow, t: TileBox) => `${page.assetKey}:${t.key}`;

interface TileProps {
  page: PageRow;
  t: TileBox;
  extra: number;
  shown: boolean;
  onDone: OnDone;
}

// A tile's box follows from its key, so a pan (same keys, same scale) re-renders nothing.
const sameTile = (a: TileProps, b: TileProps) =>
  a.t.key === b.t.key && a.page === b.page && a.extra === b.extra && a.shown === b.shown && a.onDone === b.onDone;

const Tile = memo(function Tile({ page, t, extra, shown, onDone }: TileProps) {
  const id = tileId(page, t);
  return (
    <img
      className={shown ? "bp-tile on" : "bp-tile"}
      src={assetUrl.tile(page, t.level, t.col, t.row)}
      alt=""
      draggable={false}
      decoding="async"
      // one screen px larger right/bottom: neighbours overlap instead of leaving hairline seams
      style={{ left: t.x, top: t.y, width: t.w + extra, height: t.h + extra }}
      onLoad={(e: SyntheticEvent<HTMLImageElement>) => onDone(id, true, e.currentTarget)}
      onError={(e: SyntheticEvent<HTMLImageElement>) => onDone(id, false, e.currentTarget)}
    />
  );
}, sameTile);

function RasterLayer({ page, view, size }: { page: PageRow; view: View; size: Size }) {
  const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;

  // Tiles that finished: true = loaded, false = failed (a missing tile must
  // not hold the old level on screen forever). Insertion order = age.
  const doneRef = useRef(new Map<string, boolean>());
  const done = doneRef.current;

  // Re-render (at most once per frame) when tiles finish, so the level
  // handover can complete.
  const [, setTick] = useState(0);
  const tickRaf = useRef(0);
  useEffect(() => () => cancelAnimationFrame(tickRaf.current), []);
  const onDone = useCallback<OnDone>((id, ok, img) => {
    const map = doneRef.current;
    map.delete(id);
    map.set(id, ok);
    if (map.size > DONE_MEMORY) map.delete(map.keys().next().value!);
    if (ok) img.classList.add("on"); // start the fade now, not a frame later
    if (!tickRaf.current)
      tickRaf.current = requestAnimationFrame(() => {
        tickRaf.current = 0;
        setTick((n) => n + 1);
      });
  }, []);

  const target = size.w > 0 && size.h > 0 ? pickLevel(page, view.scale, dpr) : null;
  const wanted = target === null ? [] : visibleTiles(page, view, size, target);
  const complete = wanted.every((t) => done.has(tileId(page, t)));

  // The last level whose tiles fully covered the screen: the fallback.
  const stableRef = useRef<{ level: number; assetKey: string } | null>(null);
  useLayoutEffect(() => {
    if (target !== null && complete) stableRef.current = { level: target, assetKey: page.assetKey };
  });
  const fb = stableRef.current?.assetKey === page.assetKey ? stableRef.current.level : null;
  const fallback =
    target !== null && fb !== null && fb !== target && !complete
      ? visibleTiles(page, view, size, fb, 0).filter((t) => done.get(tileId(page, t)) === true)
      : [];

  // ≥ 1 screen px of overlap, in world px. Stepped (4 steps per doubling of
  // the zoom) so a pinch doesn't re-render every tile on every frame.
  const extra = 1 / 2 ** (Math.floor(Math.log2(view.scale) * 4) / 4);

  return (
    <>
      <div
        className="bp-sheet"
        style={{ transform: `translate(${view.tx}px, ${view.ty}px)`, width: page.width * view.scale, height: page.height * view.scale }}
      />
      <div
        className="bp-raster"
        style={{ width: page.width, height: page.height, transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})` }}
      >
        <img className="bp-preview" src={assetUrl.preview(page)} alt="" draggable={false} decoding="async" />
        {/* the fallback first, so the wanted level paints over it as it arrives */}
        {fallback.map((t) => (
          <Tile key={tileId(page, t)} page={page} t={t} extra={extra} shown onDone={onDone} />
        ))}
        {wanted.map((t) => (
          <Tile key={tileId(page, t)} page={page} t={t} extra={extra} shown={done.get(tileId(page, t)) === true} onDone={onDone} />
        ))}
      </div>
    </>
  );
}

export default memo(RasterLayer);
