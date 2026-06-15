"use client";

import { useEffect, useState, useCallback, useRef } from "react";
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
  // Saved on right-click mousedown so contextmenu can read it even if WebkitGTK
  // clears the DOM selection before the contextmenu event fires.
  const pendingSelectionRef = useRef<string>("");
  // Ref to the overlay div — used in handleMouseDown to skip close() for inside-overlay
  // clicks without stopPropagation (which breaks the pointer event chain in WebkitGTK).
  const overlayRef = useRef<HTMLDivElement>(null);

  const handleContextMenu = useCallback((e: MouseEvent) => {
    e.preventDefault();

    // Use selection captured at mousedown time (WebkitGTK may clear it before contextmenu fires).
    const selectedText = pendingSelectionRef.current || (window.getSelection()?.toString() ?? "");
    pendingSelectionRef.current = "";
    const canCopy = selectedText.length > 0;

    const target = e.target as HTMLElement;
    const canPaste =
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target.isContentEditable;

    if (!canCopy && !canPaste) {
      setMenu(null);
      return;
    }

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

  const handleMouseDown = useCallback((e: MouseEvent) => {
    // Never close the menu when clicking inside the overlay — use contains() instead of
    // stopPropagation so the full event chain reaches WebkitGTK and pointer events work.
    if (overlayRef.current?.contains(e.target as Node)) return;

    if (e.button === 2) {
      pendingSelectionRef.current = window.getSelection()?.toString() ?? "";
    } else {
      pendingSelectionRef.current = "";
    }
    setMenu(null);
  }, []);

  const handleCopy = useCallback(() => {
    const text = menu?.selectedText ?? "";
    setMenu(null);
    if (!text) return;
    // Always use the Tauri plugin — navigator.clipboard in WebkitGTK can write
    // to the X11 primary selection instead of the OS clipboard.
    writeText(text).catch(() => {});
  }, [menu]);

  const handlePaste = useCallback(() => {
    const target = menu?.target ?? null;
    const selStart = menu?.selStart ?? 0;
    const selEnd = menu?.selEnd ?? 0;
    setMenu(null);
    if (!target) return;

    // Use the Tauri plugin — navigator.clipboard.readText() requires a user-gesture
    // context that WebkitGTK considers expired by the time our async handler runs.
    // The Tauri plugin makes a direct Rust call that bypasses this restriction.
    readText()
      .then((text) => {
        if (text) {
          target.focus();
          insertAt(target, text, selStart, selEnd);
        }
      })
      .catch(() => {});
  }, [menu]);

  useEffect(() => {
    document.addEventListener("contextmenu", handleContextMenu);
    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("contextmenu", handleContextMenu);
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", close);
    };
  }, [handleContextMenu, handleMouseDown, close]);

  if (!menu) return null;

  return (
    <div
      ref={overlayRef}
      className="fixed z-9999 select-none"
      style={{
        top: menu.y,
        left: menu.x,
        background: "rgba(8,8,25,0.96)",
        border: "1px solid rgba(var(--neon-purple-rgb),0.35)",
        backdropFilter: "blur(16px)",
        boxShadow: "0 4px 20px rgba(0,0,0,0.6), 0 0 10px rgba(var(--neon-purple-rgb),0.08)",
        borderRadius: "8px",
        overflow: "hidden",
        padding: "4px 0",
        minWidth: "150px",
      }}
    >
      {menu.canCopy && (
        <ContextMenuItem label="Copy" shortcut="Ctrl+C" onClick={handleCopy} />
      )}
      {menu.canCopy && menu.canPaste && (
        <div
          style={{
            height: 1,
            background: "rgba(var(--neon-purple-rgb),0.15)",
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
      className="w-full flex items-center justify-between px-3 py-1.5 text-xs cursor-default hover:bg-[rgba(var(--neon-purple-rgb),0.12)] transition-colors"
      style={{ color: "var(--text-primary)" }}
      onPointerUp={(e) => {
        if (e.button === 0) onClick();
      }}
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
