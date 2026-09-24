import "@feedbacks/ui/tokens.css";
import "@feedbacks/ui/base.css";
import "@feedbacks/ui/ui.css";
import "./i18n";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { router } from "./router";

// biome-ignore lint/style/noNonNullAssertion: #root is in index.html
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
