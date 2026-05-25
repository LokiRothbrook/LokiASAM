"use client";

import { useEffect, useState, useCallback } from "react";
import { writeText, readText } from "@tauri-apps/plugin-clipboard-manager";

interface MenuState {
  x: number;
  y: number;
  canCopy: boolean;
  selectedText: string; // captured at right-click time before click clears the selection
  canPaste: boolean;
  target: HTMLElement | null;
  selStart: number; // cursor position at right-click time
  selEnd: number;
}

export function DisableContextMenu() {
  const [menu, setMenu] = useState<MenuState | null>(null);

  const handleContextMenu = useCallback((e: MouseEvent) => {
    e.preventDefault();

    // Capture selection NOW — a subsequent mousedown/click will clear it.
    const selectedText = window.getSelection()?.toString() ?? "";
    const canCopy = selectedText.length > 0;

    const target = e.target as HTMLElement;
    const canPaste =
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target.isContentEditable;

    if (!canCopy && !canPaste) return;

    // Capture cursor position so paste inserts at the right spot.
    let selStart = 0;
    let selEnd = 0;
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement
    ) {
      selStart = target.selectionStart ?? target.value.length;
      selEnd = target.selectionEnd ?? target.value.length;
    }

    const menuW = 160;
    const menuH = (canCopy ? 32 : 0) + (canPaste ? 32 : 0) + 8;
    const x =
      e.clientX + menuW > window.innerWidth ? e.clientX - menuW : e.clientX;
    const y =
      e.clientY + menuH > window.innerHeight ? e.clientY - menuH : e.clientY;

    setMenu({ x, y, canCopy, selectedText, canPaste, target, selStart, selEnd });
  }, []);

  const close = useCallback(() => setMenu(null), []);

  const handleCopy = useCallback(() => {
    const text = menu?.selectedText ?? "";
    setMenu(null);
    if (!text) return;
    // navigator.clipboard is the most reliable path in Tauri's WebView on all
    // platforms. Fall back to the Tauri plugin if the browser API isn't available.
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).catch(() => writeText(text).catch(() => {}));
    } else {
      writeText(text).catch(() => {});
    }
  }, [menu]);

  const handlePaste = useCallback(() => {
    const target = menu?.target ?? null;
    const selStart = menu?.selStart ?? 0;
    const selEnd = menu?.selEnd ?? 0;
    setMenu(null);
    if (!target) return;

    // rAF: let the menu overlay disappear so the target can regain focus first.
    requestAnimationFrame(() => {
      target.focus();
      // Use the Tauri clipboard plugin — reads from the real OS clipboard.
      readText()
        .then((text) => {
          if (text) insertAt(target, text, selStart, selEnd);
        })
        .catch(() => {});
    });
  }, [menu]);

  useEffect(() => {
    document.addEventListener("contextmenu", handleContextMenu);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("contextmenu", handleContextMenu);
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [handleContextMenu, close]);

  if (!menu) return null;

  return (
    <div
      className="fixed z-[9999] select-none"
      style={{
        top: menu.y,
        left: menu.x,
        background: "rgba(8,8,25,0.96)",
        border: "1px solid rgba(191,0,255,0.35)",
        backdropFilter: "blur(16px)",
        boxShadow: "0 4px 20px rgba(0,0,0,0.6), 0 0 10px rgba(191,0,255,0.08)",
        borderRadius: "8px",
        overflow: "hidden",
        padding: "4px 0",
        minWidth: "150px",
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {menu.canCopy && (
        <ContextMenuItem label="Copy" shortcut="Ctrl+C" onClick={handleCopy} />
      )}
      {menu.canCopy && menu.canPaste && (
        <div
          style={{
            height: 1,
            background: "rgba(191,0,255,0.15)",
            margin: "2px 8px",
          }}
        />
      )}
      {menu.canPaste && (
        <ContextMenuItem
          label="Paste"
          shortcut="Ctrl+V"
          onClick={handlePaste}
        />
      )}
    </div>
  );
}

/** Insert `text` into a React-controlled input/textarea at the stored cursor range. */
function insertAt(
  target: HTMLElement,
  text: string,
  start: number,
  end: number
) {
  if (
    !(target instanceof HTMLInputElement) &&
    !(target instanceof HTMLTextAreaElement)
  )
    return;

  const newVal = target.value.slice(0, start) + text + target.value.slice(end);

  // Use the native value setter so React's synthetic onChange fires correctly.
  const proto =
    target instanceof HTMLInputElement
      ? HTMLInputElement.prototype
      : HTMLTextAreaElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  setter?.call(target, newVal);
  target.dispatchEvent(new Event("input", { bubbles: true }));
  target.setSelectionRange(start + text.length, start + text.length);
}

function ContextMenuItem({
  label,
  shortcut,
  onClick,
}: {
  label: string;
  shortcut: string;
  onClick: () => void;
}) {
  return (
    <button
      className="w-full flex items-center justify-between px-3 py-1.5 text-xs cursor-default hover:bg-[rgba(191,0,255,0.12)] transition-colors"
      style={{ color: "var(--text-primary)" }}
      onClick={onClick}
    >
      <span>{label}</span>
      <span
        className="font-mono"
        style={{ color: "var(--text-subtle)", fontSize: "10px" }}
      >
        {shortcut}
      </span>
    </button>
  );
}
