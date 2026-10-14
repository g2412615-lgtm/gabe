import { createRoot } from "react-dom/client";
import App from "./App";
// Montserrat, the brand's headline face, served from this app (no font CDN:
// the CSP allows 'self' only). Latin only, the three weights the brand uses.
import "@fontsource/montserrat/latin-600.css";
import "@fontsource/montserrat/latin-800.css";
import "@fontsource/montserrat/latin-900.css";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/components.css";
import "./styles/canvas.css";
import "./styles/editor.css";

// iPad Safari zooms the whole page on a pinch anywhere outside the canvas
// (it ignores user-scalable=no). The canvas handles its own pinch, so the
// page-level gesture is always cancelled.
for (const type of ["gesturestart", "gesturechange", "gestureend"]) {
  document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
}

createRoot(document.getElementById("root")!).render(<App />);
