"use client";

/**
 * RconManager — global side-effect component that maintains RCON connections.
 *
 * Strategy:
 *   1. On mount: attempt to connect all currently-running servers.
 *   2. server://any-change → immediately connect when a server becomes "running".
 *   3. rcon://status-any  → immediately reconnect when the Rust manager task
 *      reports a disconnection for a server that is still running.
 *   4. 60 s safety-net interval: catches any edge case where events were missed.
 *
 * The Rust manager task owns all polling (listplayers every 30 s, GetChat
 * every 5 s).  This component only handles connection lifecycle.
 */

import { useEffect } from "react";
import { getServers } from "@/lib/db";
import { tauriCmd, type ServerStatus, type RconStatusPayload } from "@/lib/tauri-commands";
import { useTauriEvent } from "@/hooks/useTauriEvent";

const SAFETY_NET_MS = 60_000;

async function connectServer(serverId: string, host: string, rconPort: number, rconPassword: string) {
  try {
    await tauriCmd.rconConnect(serverId, host, rconPort, rconPassword);
  } catch {
    // Server RCON not ready yet — the safety-net interval or next status event
    // will retry automatically.
  }
}

export function RconManager() {
  // ── Initial connect for all running servers on mount ──────────────────────
  useEffect(() => {
    getServers().then((servers) => {
      for (const s of servers) {
        if (s.status === "running") {
          connectServer(s.id, "127.0.0.1", s.rcon_port, s.admin_password);
        }
      }
    }).catch(() => null);
  }, []);

  // ── React immediately when a server becomes "running" ─────────────────────
  useTauriEvent<ServerStatus>("server://any-change", (payload) => {
    if (payload.status === "running") {
      // Fetch the server row to get rcon_port and admin_password.
      getServers().then((servers) => {
        const s = servers.find((srv) => srv.id === payload.serverId);
        if (s) connectServer(s.id, "127.0.0.1", s.rcon_port, s.admin_password);
      }).catch(() => null);
    }

    // Clean up the pool entry when the server stops.
    if (["stopped", "crashed", "start-failed"].includes(payload.status)) {
      tauriCmd.rconDisconnect(payload.serverId).catch(() => null);
    }
  });

  // ── Reconnect when the Rust manager reports a disconnection ───────────────
  useTauriEvent<RconStatusPayload>("rcon://status-any", (payload) => {
    if (payload.status !== "disconnected") return;
    getServers().then((servers) => {
      const s = servers.find((srv) => srv.id === payload.serverId);
      if (s && s.status === "running") {
        connectServer(s.id, "127.0.0.1", s.rcon_port, s.admin_password);
      }
    }).catch(() => null);
  });

  // ── 60 s safety-net: reconnect any running server that lost its connection ─
  useEffect(() => {
    const id = setInterval(async () => {
      const servers = await getServers().catch(() => []);
      for (const s of servers) {
        if (s.status !== "running") continue;
        const connected = await tauriCmd.rconIsConnected(s.id).catch(() => false);
        if (!connected) {
          connectServer(s.id, "127.0.0.1", s.rcon_port, s.admin_password);
        }
      }
    }, SAFETY_NET_MS);
    return () => clearInterval(id);
  }, []);

  return null;
}
