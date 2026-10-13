// Draws the app icon (the brand mark: a graphite tile with two grey rings and
// one lit amber ring) at the sizes browsers and the iPad home screen use.
// Run once after changing the design: node scripts/make-icons.mjs
import sharp from "sharp";

const svg = (size, pad) => {
  const s = size, p = pad;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 100 100">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2a303a"/><stop offset="1" stop-color="#1b1f26"/></linearGradient>
    <filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3.2"/></filter>
    <pattern id="grid" width="10" height="10" patternUnits="userSpaceOnUse"><path d="M10 0H0V10" fill="none" stroke="rgba(255,255,255,0.05)" stroke-width="1"/></pattern>
  </defs>
  <rect x="${p}" y="${p}" width="${100 - 2 * p}" height="${100 - 2 * p}" rx="${p ? 22 : 0}" fill="url(#g)"/>
  <rect x="${p}" y="${p}" width="${100 - 2 * p}" height="${100 - 2 * p}" rx="${p ? 22 : 0}" fill="url(#grid)"/>
  <circle cx="33" cy="34" r="11" fill="none" stroke="#b3bac6" stroke-width="5"/>
  <circle cx="34" cy="68" r="7" fill="none" stroke="#858d9b" stroke-width="4.5"/>
  <circle cx="64" cy="60" r="18" fill="none" stroke="#f7a81b" stroke-width="7" filter="url(#glow)" opacity="0.8"/>
  <circle cx="64" cy="60" r="18" fill="rgba(247,168,27,0.18)" stroke="#f7a81b" stroke-width="6"/>
</svg>`;
};

await sharp(Buffer.from(svg(512, 0))).png().toFile("public/icon-512.png");
await sharp(Buffer.from(svg(192, 0))).png().toFile("public/icon-192.png");
await sharp(Buffer.from(svg(180, 0))).png().toFile("public/apple-touch-icon.png");
await sharp(Buffer.from(svg(64, 4))).png().toFile("public/favicon.png");
console.log("icons written to public/");
