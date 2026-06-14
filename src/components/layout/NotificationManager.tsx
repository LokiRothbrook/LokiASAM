"use client";

/**
 * NotificationManager — mounts once in the root layout.
 *
 * Server status notifications are now dispatched from Rust (dispatch_notification
 * in notifications.rs), so they fire even when the WebKit webview is throttled
 * in the system tray. This component just handles the two frontend-facing events:
 *
 *   - `notification://toast`  → show a Sonner toast when the window is visible
 *   - `notification://logged` → bump the bell badge unread counter
 */

import { toast } from "sonner";
import { useTauriEvent } from "@/hooks/useTauriEvent";
import { useAppStore } from "@/store/useAppStore";

export function NotificationManager() {
  useTauriEvent<{ severity: string; title: string; body: string }>(
    "notification://toast",
    ({ severity, title, body }) => {
      const msg = body ? `${title} — ${body}` : title;
      if (severity === "success") toast.success(msg);
      else if (severity === "warning") toast.warning(msg);
      else if (severity === "error") toast.error(msg);
      else toast(msg);
    }
  );

  useTauriEvent<{ serverId?: string; unread: boolean }>(
    "notification://logged",
    ({ unread }) => {
      if (unread) useAppStore.getState().incrementUnread();
    }
  );

  return null;
}
