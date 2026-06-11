"use client";

/**
 * LogWatcherManager — global side-effect component that tails ShooterGame.log
 * for all running servers.
 *
 * Ensures player://login-any events are emitted even when the Logs tab is never
 * opened, so login backups and player activity tracking work in the background.
 *
 * LogsTab may restart the watcher (for backfill) when it mounts — that's fine.
 * This manager re-owns the watcher once the tab unmounts or after server restart.
 */

import { useEffect } from "react";
import { getServers } from "@/lib/db";
import { tauriCmd, type ServerStatus } from "@/lib/tauri-commands";
import { useTauriEvent } from "@/hooks/useTauriEvent";

function logPath(installPath: string): string {
  const sep = installPath.includes("\\") ? "\\" : "/";
  return `${installPath}${sep}ShooterGame${sep}Saved${sep}Logs${sep}ShooterGame.log`;
}

async function startWatcher(serverId: string, installPath: string) {
  try {
    await tauriCmd.watchServerLog(serverId, logPath(installPath));
  } catch {
    // Not ready yet — next status event will retry.
  }
}

export function LogWatcherManager() {
  // ── Start watchers for all running/starting servers on mount ─────────────
  useEffect(() => {
    getServers().then((servers) => {
      for (const s of servers) {
        if (s.status === "running" || s.status === "starting") {
          startWatcher(s.id, s.install_path);
        }
      }
    }).catch(() => null);
  }, []);

  // ── React to server lifecycle changes ────────────────────────────────────
  useTauriEvent<ServerStatus>("server://any-change", (payload) => {
    if (payload.status === "running" || payload.status === "starting") {
      getServers().then((servers) => {
        const s = servers.find((srv) => srv.id === payload.serverId);
        if (s) startWatcher(s.id, s.install_path);
      }).catch(() => null);
    }

    if (["stopped", "crashed", "start-failed"].includes(payload.status)) {
      tauriCmd.stopLogWatch(payload.serverId).catch(() => null);
    }
  });

  return null;
}
