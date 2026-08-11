import React from "react";
import ReactDOM from "react-dom/client";
import { Popup } from "./Popup";
import { initTheme } from "../../lib/theme";

// Before render, so the first painted frame already carries the right theme.
initTheme();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Popup />
  </React.StrictMode>,
);
