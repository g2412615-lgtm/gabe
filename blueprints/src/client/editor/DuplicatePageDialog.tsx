// The Duplicate page dialog (a page's ⋯ menu): a copy of the page right
// after it, under a new name, with or without its circles and their
// comments. The server makes the page (the image is shared, so it's
// instant for a page that's ready); the circles are copied here, from what
// this device shows. The whole duplicate is one undo step.
//
// The dialog picks the copy's id when it opens and sends it with every
// try: when a reply is lost (venue Wi-Fi), trying again gets the copy the
// first try made, and its circles go onto it — never a second copy.

import { useId, useRef, useState, type KeyboardEvent } from "react";
import { MAX_LABEL_CHARS } from "../../shared/constants";
import { copyLabel } from "../../shared/labels";
import type { CircleRow, PageRow } from "../../shared/types";
import { api, ApiError, newId } from "../api";
import Dialog from "../ui/Dialog";
import { useCoarsePointer } from "../ui/media";
import Spinner from "../ui/Spinner";
import { IconFilePlus } from "../ui/icons";
import { notify } from "../ui/notify";
import { usePlanState, type PlanStore } from "../sync";
import { copyOf } from "./copyCircles";
import { plural } from "./format";

/** What comes along with the page. */
type Bring = "page" | "circles" | "comments";

export interface DuplicatePageDialogProps {
  store: PlanStore;
  page: PageRow;
  onClose(): void;
  /** The copy is made: open it. */
  onDone(pageId: string): void;
  /** False once the editor is closing (the store is going away). */
  editorAlive(): boolean;
}

const NONE: CircleRow[] = [];

export default function DuplicatePageDialog({ store, page, onClose, onDone, editorAlive }: DuplicatePageDialogProps) {
  const pages = usePlanState(store, (s) => s.pages);
  const circles = usePlanState(store, (s) => s.circlesByPage.get(page.id) ?? NONE);
  const commentsByCircle = usePlanState(store, (s) => s.commentsByCircle);
  const nComments = circles.reduce((n, c) => n + (commentsByCircle.get(c.id) ?? []).filter((m) => m.body.trim() !== "").length, 0);

  const [label, setLabel] = useState(() => copyLabel(page.label, pages.map((p) => p.label), MAX_LABEL_CHARS));
  // a duplicate is a copy of everything unless the owner says otherwise
  const [bring, setBring] = useState<Bring>(() => (nComments > 0 ? "comments" : circles.length > 0 ? "circles" : "page"));
  const [copyId] = useState(() => newId());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const labelId = useId();
  const labelRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  // with a keyboard the name takes focus (type, Enter); on a touch screen the on-screen keyboard would cover the choices
  const coarse = useCoarsePointer();

  const duplicate = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    // what to copy, as this device shows it now
    const st = store.getState();
    const live = st.circlesByPage.get(page.id) ?? NONE;
    const copies = bring === "page" ? [] : live.map((c) => copyOf(c, st.commentsByCircle.get(c.id), bring === "comments"));
    try {
      // pending page changes first (a move, say), so the copy lands where this device shows the original
      await store.flushNow();
      if (!editorAlive()) return; // left meanwhile: make nothing
      const res = await api.duplicatePage(page.id, { id: copyId, label });
      if (!editorAlive()) return; // left while it was being made: the page is there next time, without the circles
      store.addDuplicatedPage(res.pages, res.page.id, copies);
      onClose();
      onDone(res.page.id);
      notify(
        copies.length
          ? `Duplicated “${page.label}” as “${res.page.label}” with ${plural(copies.length, "circle")}.`
          : `Duplicated “${page.label}” as “${res.page.label}”.`,
        "ok",
      );
    } catch (err) {
      if (!editorAlive()) return;
      setBusy(false);
      const status = err instanceof ApiError ? err.status : 0;
      const why = status !== 0 && err instanceof Error && err.message ? err.message : "Check the connection and try again.";
      setError(`The page wasn't duplicated. ${why}`);
      // the page may be gone (404), or the copy may have been made after all: let the page list catch up
      void store.pull();
      // focus went to <body> while the form was disabled: back to the name, so Enter tries again
      if (!coarse) requestAnimationFrame(() => labelRef.current?.focus());
    }
  };

  // On a touch screen the keyboard's "done" key closes the keyboard (the choices are still to make); with a keyboard Enter duplicates.
  const onNameKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (coarse && e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      e.currentTarget.blur();
    }
  };

  const options: { value: Bring; label: string }[] = [{ value: "page", label: "Just the page" }];
  if (circles.length > 0) options.push({ value: "circles", label: `The page and its ${plural(circles.length, "circle")}` });
  if (nComments > 0) options.push({ value: "comments", label: `The page, its ${plural(circles.length, "circle")} and their ${plural(nComments, "comment")}` });

  return (
    <Dialog
      open
      title="Duplicate page"
      onClose={onClose}
      dismissible={!busy}
      onSubmit={() => void duplicate()}
      initialFocus={coarse ? bodyRef : labelRef}
      className="narrow dp-dialog"
      footer={
        <>
          <button type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy}>
            {busy ? <Spinner size={12} /> : <IconFilePlus size={14} />} {busy ? "Duplicating…" : "Duplicate"}
          </button>
        </>
      }
    >
      <div className="dp" ref={bodyRef} tabIndex={-1}>
        <p>
          A copy of “{page.label}” goes right after it.
          {page.status !== "ready" && " It's prepared again from the uploaded file, which takes a moment."}
        </p>
        <div className="field">
          <label htmlFor={labelId}>Name of the copy</label>
          <input
            ref={labelRef}
            id={labelId}
            value={label}
            maxLength={MAX_LABEL_CHARS}
            autoComplete="off"
            enterKeyHint="done"
            disabled={busy}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={onNameKey}
          />
        </div>
        {options.length > 1 && (
          <fieldset className="dp-bring" disabled={busy}>
            <legend>What comes along</legend>
            {options.map((o) => (
              <label key={o.value} className="cc-row">
                <input type="radio" name="dp-bring" value={o.value} checked={bring === o.value} onChange={() => setBring(o.value)} />
                <span>{o.label}</span>
              </label>
            ))}
          </fieldset>
        )}
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
