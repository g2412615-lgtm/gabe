// "Upload a blueprint": choose or drop a file, name the plan (prefilled from
// the file name), upload with a progress bar and a Cancel. On success the
// new plan opens; its pages keep preparing in the background.

import { useEffect, useRef, useState } from "react";
import { ApiError, uploadFile, type UploadHandle } from "../api";
import { goToLogin, navigate } from "../router";
import { MAX_PLAN_NAME_CHARS } from "../../shared/constants";
import Dialog from "../ui/Dialog";
import Dropzone from "../ui/Dropzone";
import Progress from "../ui/Progress";
import Spinner from "../ui/Spinner";
import { IconFile, IconUpload } from "../ui/icons";
import { useCoarsePointer } from "../ui/media";
import { checkUploadFile, fileKind, fileSize, planNameFromFile } from "./format";

export interface UploadDialogProps {
  open: boolean;
  /** A file chosen before the dialog opened (dropped on the page). */
  initialFile?: File | null;
  /** Several files were dropped: only the first is used (a note says so). */
  extraFiles?: number;
  onClose: () => void;
}

type Phase = "idle" | "uploading";

export default function UploadDialog({ open, initialFile = null, extraFiles = 0, onClose }: UploadDialogProps) {
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [nameEdited, setNameEdited] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [fraction, setFraction] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [skipped, setSkipped] = useState(0);
  const handle = useRef<UploadHandle | null>(null);
  const cancelled = useRef(false);
  const dropInput = useRef<HTMLInputElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const coarse = useCoarsePointer();

  // Each opening starts fresh (with the dropped file, if any).
  useEffect(() => {
    if (!open) return;
    setPhase("idle");
    setFraction(0);
    setNameEdited(false);
    setError(null);
    setFile(null);
    setName("");
    if (initialFile) choose([initialFile], true);
    setSkipped(extraFiles);
    // keyed on the opening and the dropped file only
  }, [open, initialFile]);

  // Leaving the page mid-upload stops it (nothing half-made is kept: the
  // server only creates the plan once the whole file has arrived).
  useEffect(() => () => handle.current?.abort(), []);

  function choose(files: File[], freshName = false) {
    const f = files[0];
    if (!f) return;
    setSkipped(Math.max(0, files.length - 1));
    const problem = checkUploadFile(f);
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    setFile(f);
    // follow the file until the owner types a name of their own
    if (freshName || !nameEdited) setName(planNameFromFile(f.name));
  }

  async function submit() {
    if (phase === "uploading") return;
    if (!file) {
      setError("Choose a blueprint file first.");
      return;
    }
    const planName = name.trim() || planNameFromFile(file.name) || "Event plan";
    setError(null);
    setPhase("uploading");
    setFraction(0);
    cancelled.current = false;
    const h = uploadFile(file, { planName }, setFraction);
    handle.current = h;
    try {
      const res = await h.promise;
      handle.current = null;
      navigate(`/plans/${encodeURIComponent(res.plan.id)}`);
    } catch (err) {
      handle.current = null;
      setPhase("idle");
      if (cancelled.current) return;
      if (err instanceof ApiError && err.signedOut) {
        goToLogin();
        return;
      }
      setError(err instanceof Error && err.message ? err.message : "That upload didn't work — try again.");
    }
  }

  function cancelUpload() {
    cancelled.current = true;
    handle.current?.abort();
  }

  const uploading = phase === "uploading";
  const pct = Math.round(fraction * 100);
  // once every byte has arrived the server checks the file (page count,
  // password) before it answers — that can take a few seconds for big sets
  const checking = uploading && fraction >= 1;

  return (
    <Dialog
      open={open}
      title="Upload a blueprint"
      onClose={onClose}
      dismissible={!uploading}
      onSubmit={() => void submit()}
      // a dropped file: straight to the name (Enter uploads); else the file picker
      initialFocus={initialFile ? nameInput : dropInput}
      className="upload-dialog"
      footer={
        // Distinct keys: React must not turn the clicked "Cancel upload"
        // button into the submit button during the same click (the browser
        // would then submit the form again).
        uploading ? (
          <>
            <span key="note" className="foot-note">
              Keep this page open until it's done.
            </span>
            <button key="cancel-upload" type="button" onClick={cancelUpload}>
              Cancel upload
            </button>
          </>
        ) : (
          <>
            <button key="cancel" type="button" onClick={onClose}>
              Cancel
            </button>
            <button key="upload" type="submit" className="primary" disabled={!file}>
              <IconUpload size={14} /> Upload
            </button>
          </>
        )
      }
    >
      <div className="upload-form">
        <Dropzone
          onFiles={choose}
          inputRef={dropInput}
          disabled={uploading}
          hasFile={!!file}
          icon={file ? <IconFile size={20} /> : undefined}
          title={file ? file.name : undefined}
          hint={file ? `${fileKind(file)} · ${fileSize(file.size)}${uploading ? "" : ` · ${coarse ? "tap" : "click"} to choose a different file`}` : undefined}
        />
        {skipped > 0 && (
          <p className="help">
            Only the first file is used here. Add the other {skipped === 1 ? "file" : `${skipped} files`} from inside the plan with “Add pages”.
          </p>
        )}
        <div className="field">
          <label htmlFor="upload-plan-name">Plan name</label>
          <input
            ref={nameInput}
            id="upload-plan-name"
            value={name}
            maxLength={MAX_PLAN_NAME_CHARS}
            placeholder="e.g. Millrace Stadium — Home opener"
            disabled={uploading}
            autoComplete="off"
            enterKeyHint="go"
            onChange={(e) => {
              setName(e.target.value);
              setNameEdited(true);
            }}
          />
        </div>
        {uploading && (
          <Progress
            value={checking ? null : fraction}
            label={
              checking ? (
                <span className="ico-btn">
                  <Spinner size={11} /> Checking the file…
                </span>
              ) : (
                `Uploading… ${pct}%`
              )
            }
          />
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
