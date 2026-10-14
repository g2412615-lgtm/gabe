// The blueprint canvas (SPEC §7.5): pan/zoom a page, see and edit its
// circles. Touch is first-class: one finger pans, two fingers pinch and pan,
// tap selects, long-press adds, handles resize, the selected circle's grip
// (or the whole circle, while it's small) drags it.
//
//   .bp-canvas            fills the stage (the stage must be position: relative)
//     .bp-surface         every gesture lands here; children take no pointer events
//       .bp-sheet         white paper with a 1px edge, screen px
//       .bp-raster        preview + deep-zoom tiles, world px, one CSS transform
//       svg.bp-annos      circles (world group) + selection/handles (screen px)
//       .bp-hold          long-press rings
//     .bp-hint            add-mode hint
//     .bp-zoom            zoom controls
//
// The controller owns the view and the gestures; this component only draws
// its once-per-frame snapshot.

import { forwardRef, memo, useImperativeHandle, useLayoutEffect, useReducer, useRef, useSyncExternalStore } from "react";
import { useMediaQuery } from "../../ui/media";
import AnnotationLayer from "./AnnotationLayer";
import { AddHint, ZoomControls } from "./CanvasChrome";
import { CanvasController } from "./controller";
import RasterLayer from "./RasterLayer";
import type { BlueprintCanvasProps, CanvasHandle } from "./types";
import { scaleLimits } from "./viewMath";

export type { BlueprintCanvasProps, CanvasGestureEvent, CanvasHandle, CanvasMode } from "./types";

const BlueprintCanvas = forwardRef<CanvasHandle, BlueprintCanvasProps>(function BlueprintCanvas(props, ref) {
  const { page, circles, selectedId, litId, mode, topInset = 0, rightInset = 0, bottomInset = 0, onCancelAdd } = props;

  const ctlRef = useRef<CanvasController | null>(null);
  if (!ctlRef.current) ctlRef.current = new CanvasController(props);
  const ctl = ctlRef.current;
  // Handles sit further out on a touch screen; drawing and hit testing must agree.
  const coarse = useMediaQuery("(pointer: coarse)");

  // Handlers read the latest props through the controller.
  useLayoutEffect(() => {
    ctl.setCoarse(coarse);
    ctl.setProps(props);
  });

  // Measure and pick the first view before the browser paints, then draw it
  // right away (a store subscription would only catch up after a blank frame).
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  useLayoutEffect(() => {
    const detach = ctl.attach(surfaceRef.current!);
    redraw();
    return detach;
  }, [ctl]);

  useImperativeHandle(ref, () => ctl.handle, [ctl]);

  const snap = useSyncExternalStore(ctl.subscribe, ctl.getSnapshot, ctl.getSnapshot);
  const { view, size, ready } = snap;
  const drawable = ready && page.width > 0 && page.height > 0;

  const limits = drawable ? scaleLimits(page, size) : null;
  // 100% = the whole page fits the stage (stable while the side panel opens and closes)
  const pct = limits ? Math.max(1, Math.round((view.scale / limits.fit) * 100)) : 100;

  return (
    <div className={`bp-canvas${mode === "add" ? " is-add" : ""}`}>
      <div ref={surfaceRef} className="bp-surface">
        {drawable && (
          <>
            <RasterLayer page={page} view={view} size={size} zooming={snap.zooming} />
            <AnnotationLayer
              page={page}
              circles={circles}
              view={view}
              size={size}
              selectedId={selectedId}
              hoverId={snap.hoverId}
              litId={litId}
              draft={snap.draft}
              addPreview={snap.addPreview}
              coarse={coarse}
              mode={mode}
            />
            {snap.holds.map((h) => (
              <div key={h.id} className="bp-hold" style={{ left: h.x, top: h.y }} aria-hidden="true" />
            ))}
          </>
        )}
      </div>
      {mode === "add" && <AddHint topInset={topInset} rightInset={rightInset} onCancel={onCancelAdd} />}
      {drawable && limits && (
        <ZoomControls
          pct={pct}
          canZoomIn={view.scale < limits.max * 0.999}
          canZoomOut={view.scale > limits.min * 1.001}
          rightInset={rightInset}
          bottomInset={bottomInset}
          onZoomIn={ctl.handle.zoomIn}
          onZoomOut={ctl.handle.zoomOut}
          onFit={ctl.handle.fit}
        />
      )}
    </div>
  );
});

export default memo(BlueprintCanvas);
