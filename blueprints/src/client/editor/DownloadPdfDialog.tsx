// The Download PDF dialog (the sidebar's "Download PDF", or a page's ⋯ menu):
// the chosen pages as one PDF, each as it was uploaded with its circles drawn
// on, and — unless the owner says otherwise — a notes page after each page
// with circles (number, colour and what it means, title, comments).
//
// The server makes the PDF (POST /api/plans/:id/export) from what it has, so
// this device's unsaved changes are sent first; if they can't be, nothing is
// made (the PDF would leave them out). Then the file comes down with
// progress. A computer saves it straight away; an iPad or iPhone needs a
// tap to save or share it (the browser allows that only right after one).

import { useEffect, useId, useRef, useState } from "react";
import { CIRCLE_COLOR_ORDER, CIRCLE_COLORS } from "../../shared/constants";
import { pdfFileName } from "../../shared/labels";
import type { CircleColor, CircleRow } from "../../shared/types";
import { ApiError, downloadPlanPdf, type PdfDownload } from "../api";
import { fileSize } from "../home/format";
import Dialog from "../ui/Dialog";
import { useCoarsePointer } from "../ui/media";
import Progress from "../ui/Progress";
import { saveFile, shareableFile, shareFile } from "../ui/saveFile";
import Spinner from "../ui/Spinner";
import { IconDownload } from "../ui/icons";
import { usePlanState, type PlanStore } from "../sync";
import { plural } from "./format";
import { PageThumb } from "./PageSidebar";

export interface DownloadPdfDialogProps {
  store: PlanStore;
  /** The pages ticked to start with; null: every page. */
  pageIds: string[] | null;
  /** Colours hidden on this device: offered as "only the colours shown". */
  hiddenColors: ReadonlySet<CircleColor>;
  onClose(): void;
  /** False once the editor is closing. */
  editorAlive(): boolean;
}

type Phase = { step: "choose" } | { step: "saving" } | { step: "making" } | { step: "downloading"; progress: number | null } | { step: "ready"; blob: Blob; name: string };

const NONE: CircleRow[] = [];

/** Mount one per opening (a new key each time): it starts from the request. */
export default function DownloadPdfDialog({ store, pageIds, hiddenColors, onClose, editorAlive }: DownloadPdfDialogProps) {
  const plan = usePlanState(store, (s) => s.plan);
  const pages = usePlanState(store, (s) => s.pages);
  const circlesByPage = usePlanState(store, (s) => s.circlesByPage);
  const coarse = useCoarsePointer();

  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set(pageIds ?? pages.map((p) => p.id)));
  const [notes, setNotes] = useState(true);
  const [onlyShown, setOnlyShown] = useState(false);
  const [phase, setPhase] = useState<Phase>({ step: "choose" });
  const [error, setError] = useState<string | null>(null);
  const request = useRef<PdfDownload | null>(null);
  const pagesId = useId();
  const bodyRef = useRef<HTMLDivElement>(null);

  // closing the dialog stops a download on its way
  useEffect(() => () => request.current?.abort(), []);

  const chosen = pages.filter((p) => picked.has(p.id));
  const colors = onlyShown ? CIRCLE_COLOR_ORDER.filter((c) => !hiddenColors.has(c)) : CIRCLE_COLOR_ORDER;
  const countCircles = (pageId: string) => (circlesByPage.get(pageId) ?? NONE).filter((c) => colors.includes(c.color)).length;
  const nCircles = chosen.reduce((n, p) => n + countCircles(p.id), 0);
  const allPicked = pages.length > 0 && chosen.length === pages.length;
  const busy = phase.step === "saving" || phase.step === "making" || phase.step === "downloading";
  const name = pdfFileName(plan?.name ?? "", chosen.length === 1 ? chosen[0].label : null);

  const toggle = (id: string) =>
    setPicked((s) => {
      const next = new Set(s);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const download = async () => {
    if (busy || chosen.length === 0 || !plan) return;
    setError(null);
    setPhase({ step: "saving" });
    // the server makes the PDF from what it has: this device's changes go first
    await store.flushNow();
    if (!editorAlive()) return;
    if (store.hasUnsaved()) {
      setPhase({ step: "choose" });
      const st = store.getState().save.state;
      setError(
        st === "signedOut"
          ? "You've been signed out. Sign in again, then download the PDF: your latest changes are kept on this device until then."
          : "Some changes on this device haven't reached the server yet, so they wouldn't be in the PDF. Check the connection, then try again.",
      );
      return;
    }
    setPhase({ step: "making" });
    const req = downloadPlanPdf(
      plan.id,
      {
        pageIds: chosen.map((p) => p.id),
        colors: onlyShown ? colors : undefined,
        notes,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
      {
        onReady: () => setPhase({ step: "downloading", progress: null }),
        onProgress: (progress) => setPhase({ step: "downloading", progress }),
      },
    );
    request.current = req;
    try {
      const blob = await req.promise;
      if (!editorAlive() || request.current !== req) return;
      request.current = null;
      setPhase({ step: "ready", blob, name });
      // a computer takes the download now; a touch device waits for a tap (see Save PDF)
      if (!coarse) saveFile(blob, name);
    } catch (err) {
      if (!editorAlive() || request.current !== req) return;
      request.current = null;
      setPhase({ step: "choose" });
      const why = err instanceof ApiError && err.message ? err.message : "Check the connection and try again.";
      setError(`The PDF wasn't made. ${why}`);
    }
  };

  const share = phase.step === "ready" ? shareableFile(phase.blob, phase.name) : null;

  const footer =
    phase.step === "ready" ? (
      <>
        {share && (
          <button type="button" onClick={() => void shareFile(share)}>
            Share…
          </button>
        )}
        <button type="button" onClick={() => saveFile(phase.blob, phase.name)}>
          <IconDownload size={14} /> {coarse ? "Save PDF" : "Download again"}
        </button>
        <button type="button" className="primary" onClick={onClose}>
          Done
        </button>
      </>
    ) : (
      <>
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className="primary" disabled={busy || chosen.length === 0}>
          {busy ? <Spinner size={12} /> : <IconDownload size={14} />} {busy ? "Making the PDF…" : "Download PDF"}
        </button>
      </>
    );

  return (
    <Dialog open title="Download PDF" onClose={onClose} onSubmit={() => void download()} initialFocus={bodyRef} className="narrow dl-dialog" footer={footer}>
      <div className="cc dl" ref={bodyRef} tabIndex={-1}>
        {phase.step === "ready" ? (
          <div className="dl-ready" role="status">
            <p>
              <b>{phase.name}</b> is ready ({fileSize(phase.blob.size)}).
            </p>
            <p>{coarse ? (share ? "Save it to Files, or share it by email or AirDrop." : "Press Save PDF to keep it on this device.") : "It's in your downloads. If it didn't start, press Download again."}</p>
          </div>
        ) : (
          <>
            <section className="cc-sec" role="group" aria-labelledby={pagesId}>
              <div className="cc-sec-h">
                <h4 id={pagesId}>Pages</h4>
                {pages.length > 1 && (
                  <button type="button" className="ghost small" disabled={busy} onClick={() => setPicked(allPicked ? new Set() : new Set(pages.map((p) => p.id)))}>
                    {allPicked ? "Clear" : "Select all"}
                  </button>
                )}
              </div>
              <ul className="cc-list cc-pages">
                {pages.map((p, i) => (
                  <li key={p.id}>
                    <label className="cc-row cc-page">
                      <input type="checkbox" checked={picked.has(p.id)} disabled={busy} onChange={() => toggle(p.id)} />
                      <PageThumb page={p} />
                      <span className="cc-page-text">
                        <span className="cc-page-label">
                          <span className="ps-index">{i + 1}</span>
                          {p.label}
                        </span>
                        <span className="ps-meta">{plural(countCircles(p.id), "circle")}</span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </section>

            <div className="dl-opts">
              <label className="cc-check">
                <input type="checkbox" checked={notes} disabled={busy} onChange={(e) => setNotes(e.target.checked)} />
                <span>
                  Add a notes page after each page with circles
                  <small>Each circle’s number, color, title and comments</small>
                </span>
              </label>
              {hiddenColors.size > 0 && (
                <label className="cc-check">
                  <input type="checkbox" checked={onlyShown} disabled={busy} onChange={(e) => setOnlyShown(e.target.checked)} />
                  <span>
                    Only the colors shown here
                    <small>
                      {CIRCLE_COLOR_ORDER.filter((c) => !hiddenColors.has(c))
                        .map((c) => CIRCLE_COLORS[c].label)
                        .join(", ") || "No colors are shown"}
                    </small>
                  </span>
                </label>
              )}
            </div>

            <p className="dl-sum">
              {chosen.length === 0 ? "Choose the pages to download." : `${plural(chosen.length, "page")} with ${plural(nCircles, "circle")}.`}
            </p>

            {phase.step === "saving" && <Progress value={null} label="Saving your latest changes…" />}
            {phase.step === "making" && <Progress value={null} label="Making the PDF… (a big plan takes a minute)" />}
            {phase.step === "downloading" && <Progress value={phase.progress} label="Downloading…" showPercent />}
            {error && (
              <p className="error-text" role="alert">
                {error}
              </p>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}
