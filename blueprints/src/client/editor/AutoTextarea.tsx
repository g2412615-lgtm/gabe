// A textarea that grows with its text (up to `maxRows`, then scrolls).
// Used by the comment composer and the inline comment editor.

import { forwardRef, useCallback, useLayoutEffect, useRef, type TextareaHTMLAttributes } from "react";

export interface AutoTextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  value: string;
  minRows?: number;
  maxRows?: number;
}

const AutoTextarea = forwardRef<HTMLTextAreaElement, AutoTextareaProps>(function AutoTextarea(
  { value, minRows = 2, maxRows = 10, style, ...rest },
  ref,
) {
  const inner = useRef<HTMLTextAreaElement | null>(null);

  const setRefs = useCallback(
    (el: HTMLTextAreaElement | null) => {
      inner.current = el;
      if (typeof ref === "function") ref(el);
      else if (ref) ref.current = el;
    },
    [ref],
  );

  // Measure after every change of text: shrink to nothing, then take the
  // content height, clamped between min and max rows.
  useLayoutEffect(() => {
    const el = inner.current;
    if (!el) return;
    const cs = window.getComputedStyle(el);
    const line = parseFloat(cs.lineHeight) || 20;
    const borders = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
    const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + borders;
    el.style.height = "auto";
    // box-sizing is border-box: scrollHeight has the padding but not the border
    const content = el.scrollHeight + borders;
    const max = maxRows * line + pad;
    const h = Math.min(Math.max(content, minRows * line + pad), max);
    el.style.height = `${Math.ceil(h)}px`;
    el.style.overflowY = content > max + 1 ? "auto" : "hidden";
  }, [value, minRows, maxRows]);

  return <textarea ref={setRefs} value={value} rows={minRows} style={{ resize: "none", ...style }} {...rest} />;
});

export default AutoTextarea;
