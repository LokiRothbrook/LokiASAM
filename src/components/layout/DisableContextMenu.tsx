"use client";

import { useEffect } from "react";

/** Suppresses the browser/WebView right-click context menu app-wide. */
export function DisableContextMenu() {
  useEffect(() => {
    const handler = (e: MouseEvent) => e.preventDefault();
    document.addEventListener("contextmenu", handler);
    return () => document.removeEventListener("contextmenu", handler);
  }, []);
  return null;
}
