# Fonts for the "Download PDF" notes pages

mupdf's HTML layout has fonts for Latin, Greek, Cyrillic and Chinese/Japanese/Korean
built in. These cover what comments may also hold — emoji, symbols (★ ✓ ☐),
Hebrew, Arabic, Devanagari and Thai — so it prints instead of vanishing
(see `export-worker.ts`). Only the characters used end up in a PDF.

All are from the Noto project, under the SIL Open Font License 1.1 (`OFL.txt`):

- `NotoEmoji.ttf` — Noto Emoji (monochrome), google/fonts `ofl/notoemoji/NotoEmoji[wght].ttf`
- `NotoSansSymbols2-Regular.ttf`, `NotoSansHebrew-Regular.ttf`, `NotoSansArabic-Regular.ttf`,
  `NotoSansDevanagari-Regular.ttf`, `NotoSansThai-Regular.ttf` — notofonts.github.io, unhinted TTF
