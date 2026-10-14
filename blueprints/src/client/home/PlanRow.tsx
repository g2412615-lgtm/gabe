// One event plan on the home list (a row of the ruled .event-list): page 1's
// thumbnail, the name (a link that covers the row, so a tap anywhere on it
// opens the plan), a meta line, and the quiet Open + ⋯ (Rename, Delete…).

import { memo, useState } from "react";
import { assetUrl } from "../api";
import { Link } from "../router";
import { MAX_PLAN_NAME_CHARS } from "../../shared/constants";
import type { PlanSummary } from "../../shared/types";
import InlineRename from "../ui/InlineRename";
import Menu from "../ui/Menu";
import Spinner from "../ui/Spinner";
import { IconEdit, IconLayers, IconMore, IconTrash } from "../ui/icons";
import { fullDateTime, plural, relativeTime } from "./format";

export interface PlanRowProps {
  plan: PlanSummary;
  /** Ticks every minute so "edited 5 min ago" stays true. */
  now: number;
  /** The row is on its way out (delete in progress). */
  leaving?: boolean;
  onRename: (plan: PlanSummary, name: string) => void;
  onDelete: (plan: PlanSummary) => void;
}

function PlanRow({ plan, now, leaving = false, onRename, onDelete }: PlanRowProps) {
  const [renaming, setRenaming] = useState(false);
  const href = `/plans/${encodeURIComponent(plan.id)}`;

  return (
    <div className={`event-row plan-row${leaving ? " leaving" : ""}`} data-plan={plan.id}>
      <Thumb plan={plan} />
      <div className="grow">
        <div className={`name${renaming ? " renaming" : ""}`}>
          <InlineRename
            value={plan.name}
            ariaLabel="Plan name"
            maxLength={MAX_PLAN_NAME_CHARS}
            editing={renaming}
            onEditingChange={setRenaming}
            onCommit={(name) => onRename(plan, name)}
            display={<Link to={href}>{plan.name}</Link>}
          />
        </div>
        <div className="meta">
          <span>{plural(plan.pageCount, "page")}</span>
          <span className="dot-sep">{plural(plan.circleCount, "circle")}</span>
          <span className="dot-sep">{plural(plan.commentCount, "comment")}</span>
          <span className="dot-sep meta-time" title={`Last edited ${fullDateTime(plan.updatedAt)}`}>
            edited {relativeTime(plan.updatedAt, now)}
          </span>
          {plan.pendingPages > 0 && (
            <span className="pill warn">
              <Spinner size={10} /> Preparing {plural(plan.pendingPages, "page")}…
            </span>
          )}
        </div>
      </div>
      <div className="row-actions">
        <Link className="btn small" to={href}>
          Open
        </Link>
        <Menu
          label={<IconMore size={16} />}
          ariaLabel={`More for “${plan.name}”`}
          title="Rename or delete"
          buttonClassName="small icon-btn ghost"
          align="right"
          items={[
            { label: "Rename", icon: <IconEdit size={14} />, onSelect: () => setRenaming(true) },
            "separator",
            { label: "Delete…", icon: <IconTrash size={14} />, danger: true, onSelect: () => onDelete(plan) },
          ]}
        />
      </div>
    </div>
  );
}

export default memo(PlanRow);

/** Page 1 on white; a placeholder (with a spinner while it's being prepared) until its image exists. */
function Thumb({ plan }: { plan: PlanSummary }) {
  const p = plan.firstPage;
  // The thumbnail is written just after the preview; while the page is only
  // at "preview", use the preview image (which certainly exists).
  const src = p && p.assetKey ? (p.status === "ready" ? assetUrl.thumb(p) : p.status === "preview" ? assetUrl.preview(p) : null) : null;
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const preparing = !!p && (p.status === "queued" || p.status === "rendering");

  if (src && failedSrc !== src) {
    return (
      <div className="plan-thumb">
        <img src={src} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setFailedSrc(src)} />
      </div>
    );
  }
  return (
    <div className="plan-thumb placeholder" aria-hidden="true">
      {preparing ? <Spinner size={16} /> : <IconLayers size={20} />}
    </div>
  );
}
