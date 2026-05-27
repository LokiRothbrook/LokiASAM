"use client";

/**
 * NotificationManager — mounts once in the root layout.
 *
 * Subscribes to `server://any-change` Tauri events and fires
 * `dispatchNotification` for status transitions worth notifying about:
 *   - server started → success
 *   - server stopped → info
 *   - server crashed → error
 *
 * The dispatch function persists the event to SQLite, bumps the Zustand
 * unread counter (so the bell icon refreshes), and fires any configured
 * external channels (OS toast, Discord, email).
 */

import { useRef } from "react";
import { useTauriEvent } from "@/hooks/useTauriEvent";
import { dispatchNotification } from "@/lib/notifications";
import { getServer } from "@/lib/db";
import { NOTIFICATION_EVENTS } from "@/data/game-data";
import type { ServerStatus } from "@/lib/tauri-commands";

export function NotificationManager() {
  // Debounce: track the last status per server so we don't emit duplicate
  // notifications when the crash-monitor fires after the per-server watcher
  // already handled the same transition.
  const lastStatusRef = useRef<Map<string, string>>(new Map());

  useTauriEvent<ServerStatus>("server://any-change", async (status) => {
    const prev = lastStatusRef.current.get(status.serverId);
    if (prev === status.status) return;
    lastStatusRef.current.set(status.serverId, status.status);

    const server = await getServer(status.serverId).catch(() => null);
    const serverName = server?.name ?? status.serverId.slice(0, 8);

    if (status.status === "running") {
      await dispatchNotification({
        eventType:  NOTIFICATION_EVENTS.SERVER_STARTED,
        serverId:   status.serverId,
        serverName,
        title:      `${serverName} started`,
        body:       `Server is online${status.pid ? ` (PID ${status.pid})` : ""}.`,
        severity:   "success",
      });
    } else if (status.status === "stopped") {
      await dispatchNotification({
        eventType:  NOTIFICATION_EVENTS.SERVER_STOPPED,
        serverId:   status.serverId,
        serverName,
        title:      `${serverName} stopped`,
        body:       "Server has shut down.",
        severity:   "info",
      });
    } else if (status.status === "crashed") {
      await dispatchNotification({
        eventType:  NOTIFICATION_EVENTS.SERVER_CRASHED,
        serverId:   status.serverId,
        serverName,
        title:      `${serverName} crashed`,
        body:       "Server process exited unexpectedly. Check the Logs tab for details.",
        severity:   "error",
      });
    } else if (status.status === "start-failed") {
      const detail = status.error
        ? `Server process exited immediately after launch.\n\nProcess output:\n${status.error}`
        : "Server process exited immediately after launch. Verify that Proton-GE is configured correctly, the server files are intact, and all required ports are available.";
      await dispatchNotification({
        eventType:  NOTIFICATION_EVENTS.SERVER_START_FAILED,
        serverId:   status.serverId,
        serverName,
        title:      `${serverName} failed to start`,
        body:       detail,
        severity:   "error",
      });
    }
  });

  return null;
}
