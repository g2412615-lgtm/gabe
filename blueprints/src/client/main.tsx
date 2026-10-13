import { createRoot } from "react-dom/client";
import App from "./App";
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
