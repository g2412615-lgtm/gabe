// The Kilowatt Events logo: the official PNGs in public/brand/, used exactly
// as supplied (docs/BRAND.md) — scaled proportionally only, never recoloured,
// redrawn or stretched. The <img> gets the file's real proportions (its
// width/height attributes), and CSS may only change the height with
// `width: auto`.
//
//   variant  "lockup" — bulb + KILOWATT EVENTS wordmark (the usual mark)
//            "bulb"   — the bulb alone, for tight spaces (never next to a lockup)
//   tone     what the logo sits on:
//            "on-gold" / "on-light" → the black files
//            "on-dark"              → the white files
//            "page" (default)       → follows the page theme: black on the
//                                     light theme, white on the dark one
//                                     (system setting or <html data-theme>)

import { ORG_NAME } from "../../shared/constants";

export type LogoVariant = "lockup" | "bulb";
export type LogoTone = "page" | "on-gold" | "on-light" | "on-dark";

const FILES: Record<LogoVariant, { black: string; white: string; w: number; h: number }> = {
  lockup: { black: "/brand/lockup-black.png", white: "/brand/lockup-white.png", w: 1963, h: 526 },
  bulb: { black: "/brand/icon-black.png", white: "/brand/icon-white.png", w: 388, h: 637 },
};

/** The brand's minimum width for the lockup (1 inch). */
export const LOCKUP_MIN_WIDTH = 75;

export interface LogoProps {
  variant?: LogoVariant;
  tone?: LogoTone;
  /** Height in px; the width follows the file's proportions. Default 34 (the header band's size). */
  height?: number;
  /** Default: the company name. Pass "" when the name is already said next to it. */
  alt?: string;
  className?: string;
}

export default function Logo({ variant = "lockup", tone = "page", height = 34, alt = ORG_NAME, className }: LogoProps) {
  const f = FILES[variant];
  // the lockup never goes below its minimum width
  const h = variant === "lockup" ? Math.max(height, Math.ceil((LOCKUP_MIN_WIDTH * f.h) / f.w)) : height;
  const w = Math.round((h * f.w) / f.h);
  const cls = `logo logo-${variant}${tone === "page" ? " logo-page" : ""}${className ? ` ${className}` : ""}`;
  const img = (src: string, extra?: string) => (
    <img
      className={`logo-img${extra ? ` ${extra}` : ""}`}
      src={src}
      width={w}
      height={h}
      alt={alt}
      decoding="async"
      draggable={false}
    />
  );

  if (tone === "page") {
    // Both files; CSS shows the one that suits the theme (display: none keeps
    // the other out of the accessibility tree).
    return (
      <span className={cls}>
        {img(f.black, "logo-for-light")}
        {img(f.white, "logo-for-dark")}
      </span>
    );
  }
  return <span className={cls}>{img(tone === "on-dark" ? f.white : f.black)}</span>;
}
