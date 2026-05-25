"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import {
  Play,
  Square,
  RotateCcw,
  Users,
  Cpu,
  MemoryStick,
  Clock,
  Map,
  Package,
  HardDrive,
  ChevronRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ServerStatusBadge } from "./ServerStatusBadge";
import { ServerActionMenu } from "./ServerActionMenu";
import { useServerStats } from "@/hooks/useServerStats";
import { tauriCmd, type StartServerParams } from "@/lib/tauri-commands";
import {
  updateServerStatus,
  getServerConfig,
  getServerModCount,
  getLastBackupTime,
  getNextScheduledRestart,
  getAppSetting,
} from "@/lib/db";
import { ARK_MAPS } from "@/data/game-data";
import { useQueryClient } from "@tanstack/react-query";
import type { ServerRow } from "@/lib/db";

interface Props {
  server: ServerRow;
}

// ── Utility helpers ──────────────────────────────────────────────────────────

function formatUptime(updatedAt: string): string {
  const startMs = new Date(updatedAt).getTime();
  if (isNaN(startMs)) return "—";
  const elapsed = Date.now() - startMs;
  if (elapsed < 0) return "0m";
  const h = Math.floor(elapsed / 3_600_000);
  const m = Math.floor((elapsed % 3_600_000) / 60_000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function formatRelativeTime(iso: string | null): string {
  if (!iso) return "Never";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  const diffMs = Date.now() - d.getTime();
  const diffMins = Math.floor(Math.abs(diffMs) / 60_000);
  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  const h = Math.floor(diffMins / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function formatFutureTime(iso: string | null): string {
  if (!iso) return "Not scheduled";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  const diffMs = d.getTime() - Date.now();
  if (diffMs < 0) return "Overdue";
  const diffMins = Math.floor(diffMs / 60_000);
  if (diffMins < 60) return `in ${diffMins}m`;
  const h = Math.floor(diffMins / 60);
  if (h < 24) return `in ${h}h`;
  return `in ${Math.floor(h / 24)}d`;
}

// ── Main component ───────────────────────────────────────────────────────────

export function ServerCard({ server }: Props) {
  const queryClient = useQueryClient();
  const stats = useServerStats(server);

  const [modCount, setModCount] = useState<number | null>(null);
  const [lastBackup, setLastBackup] = useState<string | null>(null);
  const [nextRestart, setNextRestart] = useState<string | null>(null);
  const [actionPending, setActionPending] = useState(false);

  const mapDisplay =
    ARK_MAPS.find((m) => m.id === server.map_id)?.displayName ?? server.map_id;

  const isRunning = server.status === "running";
  const isTransitioning = ["starting", "stopping", "updating"].includes(server.status);

  // Load secondary card data (mod count, backup, schedule).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [mc, lb, nr] = await Promise.all([
        getServerModCount(server.id),
        getLastBackupTime(server.id),
        getNextScheduledRestart(server.id),
      ]);
      if (!cancelled) {
        setModCount(mc);
        setLastBackup(lb);
        setNextRestart(nr);
      }
    })();
    return () => { cancelled = true; };
  }, [server.id]);

  // ── Actions ──────────────────────────────────────────────────────────────

  const isLinux =
    typeof navigator !== "undefined" && !navigator.userAgent.includes("Windows");

  const buildStartParams = async (): Promise<StartServerParams> => {
    const config = await getServerConfig(server.id);
    const launchArgs: Record<string, string> = config
      ? JSON.parse(config.launch_args_json)
      : {};

    const extraArgs = Object.entries(launchArgs)
      .filter(([, v]) => v === "true" || v === "1")
      .map(([k]) => `-${k}`);

    const map = ARK_MAPS.find((m) => m.id === server.map_id);

    const params: StartServerParams = {
      serverId: server.id,
      installPath: server.install_path,
      mapPath: map?.mapPath ?? "TheIsland_WP",
      port: server.port,
      queryPort: server.query_port,
      rconPort: server.rcon_port,
      maxPlayers: server.max_players,
      serverPassword: server.server_password ?? undefined,
      adminPassword: server.admin_password,
      extraArgs,
    };

    if (isLinux) {
      params.protonPath = (await getAppSetting("proton_path")) ?? undefined;
      params.prefixPath = (await getAppSetting("proton_prefix_path")) ?? undefined;
    }

    return params;
  };

  const handleStart = async () => {
    setActionPending(true);
    try {
      await updateServerStatus(server.id, "starting", null);
      queryClient.invalidateQueries({ queryKey: ["servers"] });

      const params = await buildStartParams();
      const pid = await tauriCmd.startServer(params);

      await updateServerStatus(server.id, "running", pid);
      queryClient.invalidateQueries({ queryKey: ["servers"] });
    } catch (err) {
      console.error("Start failed:", err);
      await updateServerStatus(server.id, "error", null);
      queryClient.invalidateQueries({ queryKey: ["servers"] });
    } finally {
      setActionPending(false);
    }
  };

  const handleStop = async () => {
    setActionPending(true);
    try {
      await updateServerStatus(server.id, "stopping", server.pid);
      queryClient.invalidateQueries({ queryKey: ["servers"] });
      await tauriCmd.stopServer(server.id, true);
      // Actual "stopped" status comes via the server://any-change event from Rust.
    } catch (err) {
      console.error("Stop failed:", err);
    } finally {
      setActionPending(false);
    }
  };

  const handleRestart = async () => {
    setActionPending(true);
    try {
      await updateServerStatus(server.id, "stopping", server.pid);
      queryClient.invalidateQueries({ queryKey: ["servers"] });

      const params = await buildStartParams();
      const newPid = await tauriCmd.restartServer(params, true);

      await updateServerStatus(server.id, "running", newPid);
      queryClient.invalidateQueries({ queryKey: ["servers"] });
    } catch (err) {
      console.error("Restart failed:", err);
      await updateServerStatus(server.id, "error", null);
      queryClient.invalidateQueries({ queryKey: ["servers"] });
    } finally {
      setActionPending(false);
    }
  };

  // ── Border glow based on status ───────────────────────────────────────────

  const borderColor = isRunning
    ? "rgba(0,255,136,0.35)"
    : server.status === "error" || server.status === "crashed"
    ? "rgba(255,0,85,0.35)"
    : "rgba(191,0,255,0.2)";

  return (
    <div
      className="glass-card flex flex-col gap-4 p-5 rounded-2xl transition-all duration-300"
      style={{
        border: `1px solid ${borderColor}`,
        boxShadow: isRunning
          ? "0 0 20px rgba(0,255,136,0.08)"
          : server.status === "error" || server.status === "crashed"
          ? "0 0 20px rgba(255,0,85,0.08)"
          : undefined,
      }}
    >
      {/* ── Header row ── */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h3
              className="font-bold text-base leading-tight truncate"
              style={{ color: "var(--text-primary)" }}
            >
              {server.name}
            </h3>
            <ServerStatusBadge status={server.status} />
          </div>
          <div
            className="flex items-center gap-1 mt-1 text-xs"
            style={{ color: "var(--text-muted)" }}
          >
            <Map className="w-3 h-3 shrink-0" />
            <span>{mapDisplay}</span>
            <span className="mx-1 opacity-40">·</span>
            <span>:{server.port}</span>
          </div>
        </div>
        <ServerActionMenu server={server} />
      </div>

      {/* ── Stats grid ── */}
      <div className="grid grid-cols-2 gap-2">
        {/* Players */}
        <div className="flex items-center gap-2">
          <Users className="w-3.5 h-3.5 shrink-0" style={{ color: "var(--neon-cyan)" }} />
          <span className="text-xs" style={{ color: "var(--text-muted)" }}>
            Players
          </span>
          <span className="text-xs font-semibold ml-auto" style={{ color: "var(--text-primary)" }}>
            {isRunning && stats.playersOnline !== null
              ? `${stats.playersOnline} / ${stats.maxPlayers ?? server.max_players}`
              : `— / ${server.max_players}`}
          </span>
        </div>

        {/* Uptime */}
        <div className="flex items-center gap-2">
          <Clock className="w-3.5 h-3.5 shrink-0" style={{ color: "var(--neon-purple)" }} />
          <span className="text-xs" style={{ color: "var(--text-muted)" }}>
            Uptime
          </span>
          <span className="text-xs font-semibold ml-auto" style={{ color: "var(--text-primary)" }}>
            {isRunning ? formatUptime(server.updated_at) : "—"}
          </span>
        </div>

        {/* CPU */}
        <div className="flex items-center gap-2">
          <Cpu className="w-3.5 h-3.5 shrink-0" style={{ color: "var(--neon-green)" }} />
          <span className="text-xs" style={{ color: "var(--text-muted)" }}>
            CPU
          </span>
          <span className="text-xs font-semibold ml-auto" style={{ color: "var(--text-primary)" }}>
            {isRunning && stats.cpuPercent !== null
              ? `${stats.cpuPercent.toFixed(1)}%`
              : "—"}
          </span>
        </div>

        {/* RAM */}
        <div className="flex items-center gap-2">
          <MemoryStick className="w-3.5 h-3.5 shrink-0" style={{ color: "var(--neon-cyan)" }} />
          <span className="text-xs" style={{ color: "var(--text-muted)" }}>
            RAM
          </span>
          <span className="text-xs font-semibold ml-auto" style={{ color: "var(--text-primary)" }}>
            {isRunning && stats.memoryMb !== null
              ? `${Math.round(stats.memoryMb)} MB`
              : "—"}
          </span>
        </div>

        {/* Mods */}
        <div className="flex items-center gap-2">
          <Package className="w-3.5 h-3.5 shrink-0" style={{ color: "var(--neon-purple)" }} />
          <span className="text-xs" style={{ color: "var(--text-muted)" }}>
            Mods
          </span>
          <span className="text-xs font-semibold ml-auto" style={{ color: "var(--text-primary)" }}>
            {modCount !== null ? modCount : <Skeleton className="w-6 h-3" />}
          </span>
        </div>

        {/* Last backup */}
        <div className="flex items-center gap-2">
          <HardDrive className="w-3.5 h-3.5 shrink-0" style={{ color: "var(--neon-green)" }} />
          <span className="text-xs" style={{ color: "var(--text-muted)" }}>
            Backup
          </span>
          <span className="text-xs font-semibold ml-auto" style={{ color: "var(--text-primary)" }}>
            {formatRelativeTime(lastBackup)}
          </span>
        </div>
      </div>

      {/* Next restart */}
      {nextRestart && (
        <p className="text-xs" style={{ color: "var(--text-muted)" }}>
          Next restart:{" "}
          <span style={{ color: "var(--neon-cyan)" }}>
            {formatFutureTime(nextRestart)}
          </span>
        </p>
      )}

      {/* ── Action buttons ── */}
      <div className="flex items-center gap-2 pt-1 border-t" style={{ borderColor: "rgba(191,0,255,0.1)" }}>
        {/* Start / Stop toggle */}
        {isRunning || isTransitioning ? (
          <Button
            size="sm"
            disabled={isTransitioning || actionPending}
            onClick={handleStop}
            className="gap-1.5 flex-1"
            style={{
              background: "rgba(255,0,85,0.12)",
              borderColor: "rgba(255,0,85,0.4)",
              color: "var(--neon-red)",
            }}
          >
            <Square className="w-3.5 h-3.5" />
            {server.status === "stopping" ? "Stopping…" : "Stop"}
          </Button>
        ) : (
          <Button
            size="sm"
            disabled={actionPending}
            onClick={handleStart}
            className="gap-1.5 flex-1"
            style={{
              background: "rgba(0,255,136,0.12)",
              borderColor: "rgba(0,255,136,0.4)",
              color: "var(--neon-green)",
            }}
          >
            <Play className="w-3.5 h-3.5" />
            {server.status === "starting" ? "Starting…" : "Start"}
          </Button>
        )}

        {/* Restart */}
        <Button
          size="sm"
          variant="outline"
          disabled={!isRunning || actionPending}
          onClick={handleRestart}
          className="gap-1.5"
          style={{ color: "var(--neon-purple)", borderColor: "rgba(191,0,255,0.3)" }}
        >
          <RotateCcw className="w-3.5 h-3.5" />
          Restart
        </Button>

        {/* Open Detail */}
        <Button
          asChild
          size="sm"
          variant="outline"
          className="gap-1"
          style={{ color: "var(--neon-cyan)", borderColor: "rgba(0,255,255,0.3)" }}
        >
          <Link href={`/servers/detail?id=${server.id}`}>
            <ChevronRight className="w-3.5 h-3.5" />
          </Link>
        </Button>
      </div>
    </div>
  );
}
