// The "?" menu in the editor header: keyboard shortcuts (DeployMap's
// .shortcut-list) and, for the iPad, the touch gestures. On a touch screen
// the gestures come first.

import type { ReactNode } from "react";
import Menu from "../ui/Menu";
import { IconHelp } from "../ui/icons";
import { useCoarsePointer } from "../ui/media";
import { isMac } from "./format";

export default function HelpMenu() {
  const coarse = useCoarsePointer();
  const mod = isMac() ? "⌘" : "Ctrl";

  const keys = (
    <section className="ed-help-sec" aria-label="Keyboard shortcuts">
      <h3 className="ed-help-h">Keyboard</h3>
      <dl className="ed-help-list">
        <Row k={<kbd>V</kbd>}>Move mode</Row>
        <Row k={<kbd>C</kbd>}>Circle mode (add circles)</Row>
        <Row k={<kbd>Esc</kbd>}>Stop adding · close · deselect</Row>
        <Row k={<kbd>Delete</kbd>}>Delete the selected circle</Row>
        <Row k={<kbd>F</kbd>}>Zoom to the selected circle</Row>
        <Row k={<><kbd>{mod}</kbd><kbd>C</kbd> <kbd>{mod}</kbd><kbd>V</kbd></>}>Copy the selected circle · paste it on the open page</Row>
        <Row k={<><kbd>{mod}</kbd><kbd>Z</kbd></>}>Undo</Row>
        <Row k={isMac() ? <><kbd>⌘</kbd><kbd>⇧</kbd><kbd>Z</kbd></> : <><kbd>Ctrl</kbd><kbd>Y</kbd></>}>Redo</Row>
        <Row k={<><kbd>{mod}</kbd><kbd>S</kbd></>}>Save now</Row>
        <Row k={<><kbd>+</kbd> <kbd>−</kbd> <kbd>0</kbd></>}>Zoom in · out · fit</Row>
        <Row k={<><kbd>[</kbd> <kbd>]</kbd></>}>Previous · next page</Row>
      </dl>
    </section>
  );

  const touch = (
    <section className="ed-help-sec" aria-label="Touch gestures">
      <h3 className="ed-help-h">On an iPad</h3>
      <dl className="ed-help-list">
        <Row k="Drag">Move around the blueprint</Row>
        <Row k="Pinch">Zoom in and out</Row>
        <Row k="Double-tap">Zoom in on that spot</Row>
        <Row k="Tap a circle">Open its comments</Row>
        <Row k="Press and hold">Add a circle there</Row>
        <Row k="Drag a dot">Resize the selected circle</Row>
        <Row k="Drag the ✥ in its middle">Move the selected circle</Row>
        <Row k="⋯ beside a page">Duplicate it, or copy its circles to another page</Row>
      </dl>
    </section>
  );

  const mouse = (
    <section className="ed-help-sec" aria-label="Mouse">
      <h3 className="ed-help-h">Mouse and trackpad</h3>
      <dl className="ed-help-list">
        <Row k="Drag">Move around the blueprint</Row>
        <Row k="Right- or middle-drag">Move around, even over a circle</Row>
        <Row k="Scroll · pinch">Zoom</Row>
        <Row k="Hover a circle">Peek at its comments</Row>
        <Row k="Click a circle">Keep its comments open</Row>
        <Row k="Drag a dot">Resize the selected circle</Row>
        <Row k="Drag the ✥">Move the selected circle</Row>
        <Row k="⋯ beside a page">Duplicate it, or copy its circles to another page</Row>
      </dl>
    </section>
  );

  return (
    <Menu
      label={<IconHelp size={16} />}
      ariaLabel="Help and shortcuts"
      title="Help and shortcuts"
      buttonClassName="ghost icon-btn ed-help-btn"
      align="right"
      popClassName="ed-help-pop"
    >
      {coarse ? (
        <>
          {touch}
          {keys}
        </>
      ) : (
        <>
          {keys}
          {mouse}
          {touch}
        </>
      )}
    </Menu>
  );
}

function Row({ k, children }: { k: ReactNode; children: ReactNode }) {
  return (
    <div className="ed-help-row">
      <dt>{k}</dt>
      <dd>{children}</dd>
    </div>
  );
}
