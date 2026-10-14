// What the editor shows instead of the blueprint: a page still being
// prepared, a page that couldn't be, a plan with no pages yet — and the
// full-screen states (opening, offline, not found).

import type { ReactNode } from "react";
import type { PageRow } from "../../shared/types";
import { Link } from "../router";
import Dropzone from "../ui/Dropzone";
import EmptyArt from "../ui/EmptyArt";
import Progress from "../ui/Progress";
import Spinner from "../ui/Spinner";
import { IconAlert, IconRefresh } from "../ui/icons";
import HeaderHome from "./HeaderHome";
import type { AddPages } from "./useAddPages";

export function PreparingCard({ page }: { page: PageRow }) {
  return (
    <div className="ed-card" role="status">
      <Spinner size={22} />
      <h2>Preparing page…</h2>
      <p>
        “{page.label}” is being turned into a sharp, zoomable sheet. This takes a few seconds for big sheets.
      </p>
    </div>
  );
}

export function FailedCard({ page, onRetry }: { page: PageRow; onRetry(): void }) {
  return (
    <div className="ed-card failed" role="alert">
      <span className="ed-card-icon">
        <IconAlert size={20} />
      </span>
      <h2>This page couldn't be prepared</h2>
      <p>{page.error || "Something went wrong while preparing it."}</p>
      <div className="ed-card-actions">
        <button type="button" className="primary" onClick={onRetry}>
          <IconRefresh size={14} /> Try again
        </button>
      </div>
    </div>
  );
}

export function NoPagesCard({ uploads }: { uploads: AddPages }) {
  return (
    <div className="ed-card wide">
      <EmptyArt />
      <h2>No pages yet</h2>
      <p>Add a blueprint PDF (or a PNG or JPG). Each page becomes a sheet you can mark up with circles and comments.</p>
      <Dropzone multiple onFiles={uploads.addFiles} title="Drop blueprints here" className="ed-card-drop" />
      {uploads.items.map((it) => (
        <Progress
          key={it.id}
          className="ed-card-progress"
          value={it.phase === "sending" ? it.progress : it.phase === "waiting" ? 0 : null}
          label={it.phase === "checking" ? `Checking ${it.name}…` : it.phase === "waiting" ? `Waiting · ${it.name}` : `Uploading ${it.name}…`}
          showPercent={it.phase === "sending"}
        />
      ))}
    </div>
  );
}

/** A whole-screen message with a way back home (plan missing, can't load). */
export function EditorMessage({ title, children, busy, action }: { title: string; children?: ReactNode; busy?: boolean; action?: ReactNode }) {
  return (
    <div className="ed-root ed-message-root">
      <header className="ed-header">
        <HeaderHome />
      </header>
      <main className="ed-message">
        <div className="ed-card" role={busy ? "status" : "alert"}>
          {busy ? <Spinner size={22} /> : <EmptyArt />}
          <h2>{title}</h2>
          {children}
          <div className="ed-card-actions">
            {action}
            <Link to="/" className={`btn${action ? "" : " primary"}`}>
              Back to event plans
            </Link>
          </div>
        </div>
      </main>
    </div>
  );
}

/** While the plan is first being fetched. */
export function EditorLoading() {
  return (
    <div className="ed-root">
      <header className="ed-header">
        <HeaderHome />
        <span className="ed-title">
          <span className="ed-title-skel skeleton" aria-hidden="true" />
        </span>
      </header>
      <main className="ed-message">
        <div className="ed-loading" role="status">
          <Spinner size={16} /> Opening event plan…
        </div>
      </main>
    </div>
  );
}
