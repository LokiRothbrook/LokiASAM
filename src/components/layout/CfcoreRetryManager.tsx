"use client";

/**
 * CfcoreRetryManager — silently retries server startups that fail due to the
 * CurseForge mod API being temporarily unreachable.
 *
 * When the backend detects the "serverUnreachable" CFCore error in the server
 * log, it emits `server://cfcore-error` instead of the normal "start-failed"
 * event. This keeps the server in "starting" state in the DB. This manager
 * listens for those events, waits 1 second, then relaunches the server (which
 * archives the previous log and restarts the full startup sequence).
 *
 * After 3 consecutive cfcore failures the manager gives up, calls
 * forceServerStartFailed so the UI and NotificationManager handle it as a
 * normal failure, and dispatches a detailed notification explaining the cause.
 */

import { useRef } from "react";
import { useTauriEvent } from "@/hooks/useTauriEvent";
import { tauriCmd } from "@/lib/tauri-commands";
import { buildStartParams } from "@/lib/server-utils";
import { dispatchNotification } from "@/lib/notifications";
import { getServer } from "@/lib/db";
import { NOTIFICATION_EVENTS } from "@/data/game-data";
import type { ServerStatus } from "@/lib/tauri-commands";

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

const CFCORE_FAILURE_MESSAGE =
  "The CurseForge mod API was unreachable 3 times in a row. " +
  "This is usually a temporary outage — wait a minute and try again manually. " +
  "If it keeps happening, check that outbound port 443 is open to " +
  "api.curseforge.com in your firewall.";

export function CfcoreRetryManager() {
  // Per-server retry counts. Resets to 0 when a server reaches "running".
  const retryCountRef = useRef<Record<string, number>>({});

  // Reset count when a server successfully starts.
  useTauriEvent<ServerStatus>("server://any-change", (status) => {
    if (status.status === "running") {
      delete retryCountRef.current[status.serverId];
    }
  });

  useTauriEvent<{ serverId: string }>("server://cfcore-error", async (payload) => {
    const { serverId } = payload;
    const count = retryCountRef.current[serverId] ?? 0;

    if (count < MAX_RETRIES) {
      retryCountRef.current[serverId] = count + 1;

      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));

      const server = await getServer(serverId).catch(() => null);
      if (!server) return;

      const params = await buildStartParams(server).catch(() => null);
      if (!params) return;

      await tauriCmd.startServer(params).catch(() => null);
    } else {
      // All retries exhausted — surface the failure.
      delete retryCountRef.current[serverId];

      await tauriCmd
        .forceServerStartFailed(serverId, CFCORE_FAILURE_MESSAGE)
        .catch(() => null);

      const server = await getServer(serverId).catch(() => null);
      const serverName = server?.name ?? serverId.slice(0, 8);

      dispatchNotification({
        eventType:  NOTIFICATION_EVENTS.SERVER_START_FAILED,
        serverId,
        serverName,
        title:      `${serverName} failed to start`,
        body:       CFCORE_FAILURE_MESSAGE,
        severity:   "error",
      });
    }
  });

  return null;
}
