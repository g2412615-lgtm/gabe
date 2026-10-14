# Brand: Kilowatt Events

This app uses the Kilowatt Events brand, as packaged in the **KWE Ops Board brand kit**. The logo files in `public/brand/` and the app icons in `public/` come from that kit unaltered. The design tokens are in `src/client/styles/tokens.css`.

## Look in one line

White pages, black type, KW Gold accents, square corners, flat surfaces, and one bold dark band per screen. Copy is concise.

## Rules

**Colour**
- **KW Gold** is `#FEE000` (PMS 107 C). It is an accent, not a background for everything. Use it for:
  - the header band
  - the active-tab underline
  - focus rings
  - selection
  - highlight fills
  - link underlines
- **Text on gold is always black.** Never put white or gold text on gold, and avoid gold text on white.

**Shape and surfaces**
- **Square corners** everywhere (radius 0).
- **Flat surfaces.** Only floating UI (menus, dialogs, toasts, the zoom panel) gets a shadow.
- **Structure from rules, not boxes.** A section starts with a 2px strong rule, and rows are separated by 1px hairlines.

**Type**
- Headlines: **Montserrat 900** (Black), self-hosted through `@fontsource/montserrat`.
- Body: **Aptos**, falling back to the system UI font. Aptos isn't hosted.

**Components**
- **Header band:** gold, 72px tall (64px on phones). It holds `lockup-black.png` at 34px tall, then the app title after a 2px black divider. It stays gold with black content in dark mode.
- **Primary button:** black fill, gold text. **Accent button:** gold fill, black text. **Quiet button:** transparent, 1px border, gold on hover.
- **Toast:** black with white text and a gold Undo link.
- **Dark theme:** follows the device setting. The tokens hold both palettes.

## Logo rules

- **Use the files exactly as supplied.** Never redraw, retype, recolour, stretch, rotate, or place them over busy backgrounds. Scale proportionally only.

  | File | Use on |
  |---|---|
  | `lockup-black.png` | White, light backgrounds and KW Gold (the header band) |
  | `lockup-white.png` | Black and dark backgrounds |
  | `icon-black.png`, `icon-white.png` | The bulb on its own, when space is tight. Same colour rules. |

- **Lockup size:** 75px wide at minimum. Leave clear space on every side equal to the height of the "V" in the wordmark.
- **Never combine the bulb with the lockup.**
- **App icons** (`favicon.png`, `apple-touch-icon.png`, `icon-192.png`, `icon-512.png`) are the unaltered black bulb on a KW Gold square, which is an approved treatment.
