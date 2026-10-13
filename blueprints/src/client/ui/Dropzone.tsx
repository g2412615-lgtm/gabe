// DeployMap's big .dropzone: a <label> around a hidden file input, so a tap
// (iPad) or click opens the file picker and files can be dropped on it.
// The input stays focusable (1px, transparent), so it's a keyboard stop too:
// Tab to it and press Space.

import { useRef, useState, type DragEvent, type ReactNode, type Ref } from "react";
import { MAX_UPLOAD_MB, UPLOAD_ACCEPT } from "../../shared/constants";
import { IconUpload } from "./icons";
import { useCoarsePointer } from "./media";

export interface DropzoneProps {
  onFiles: (files: File[]) => void;
  multiple?: boolean;
  /** Default: UPLOAD_ACCEPT (PDF, PNG, JPG). */
  accept?: string;
  /** Big line. Default "Drop a blueprint here" ("Drop blueprints here" when multiple). */
  title?: ReactNode;
  /** Small line. Default "or tap to choose a file · PDF, PNG or JPG up to 150 MB" ("click" with a mouse). */
  hint?: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
  /** A file is chosen: solid amber edge. */
  hasFile?: boolean;
  /** One-line version (icon left, text right) for tight spaces. */
  compact?: boolean;
  className?: string;
  inputRef?: Ref<HTMLInputElement>;
  id?: string;
}

export default function Dropzone({
  onFiles,
  multiple = false,
  accept = UPLOAD_ACCEPT,
  title,
  hint,
  icon,
  disabled = false,
  hasFile = false,
  compact = false,
  className,
  inputRef,
  id,
}: DropzoneProps) {
  const [over, setOver] = useState(false);
  // dragenter/dragleave fire for every child element; count them
  const depth = useRef(0);
  const coarse = useCoarsePointer();

  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");

  const onDragEnter = (e: DragEvent<HTMLLabelElement>) => {
    if (disabled || !hasFiles(e)) return;
    e.preventDefault();
    depth.current += 1;
    setOver(true);
  };
  const onDragOver = (e: DragEvent<HTMLLabelElement>) => {
    if (disabled || !hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  };
  const onDragLeave = () => {
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setOver(false);
  };
  const onDrop = (e: DragEvent<HTMLLabelElement>) => {
    depth.current = 0;
    setOver(false);
    if (!hasFiles(e)) return;
    // preventDefault marks the drop as handled (a page-level drop handler checks it)
    e.preventDefault();
    if (disabled) return;
    const files = Array.from(e.dataTransfer.files);
    if (files.length) onFiles(multiple ? files : files.slice(0, 1));
  };

  const verb = coarse ? "tap" : "click";
  const big = title ?? (multiple ? "Drop blueprints here" : "Drop a blueprint here");
  const small = hint ?? `or ${verb} to choose ${multiple ? "files" : "a file"} · PDF, PNG or JPG up to ${MAX_UPLOAD_MB} MB`;

  const cls = ["dropzone", over && "over", hasFile && "has-file", compact && "compact", disabled && "disabled", className].filter(Boolean).join(" ");

  return (
    <label className={cls} onDragEnter={onDragEnter} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop} htmlFor={id}>
      <span className="dz-icon" aria-hidden="true">
        {icon ?? <IconUpload size={20} />}
      </span>
      <span className="dz-text">
        <strong>{big}</strong>
        <span className="dz-hint">{small}</span>
      </span>
      <input
        ref={inputRef}
        id={id}
        type="file"
        accept={accept}
        multiple={multiple}
        disabled={disabled}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          // clear it, so choosing the same file again still fires change
          e.target.value = "";
          if (files.length) onFiles(files);
        }}
      />
    </label>
  );
}
