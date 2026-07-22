"use client";

import { useState, useEffect, useRef } from "react";
import { useTauriEvent } from "@/hooks/useTauriEvent";
import Link from "next/link";
import { useRouter } from "next/navigation";
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
  ArrowUp,
  AlertCircle,
  XCircle,
  Terminal,
  Loader2,
  X,
  Ban,
  ToggleLeft,
  ToggleRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { CommandOutputPanel, clearOutputBuffer } from "@/components/shared/CommandOutputPanel";
import { ServerStatusBadge } from "./ServerStatusBadge";
import { ServerActionMenu } from "./ServerActionMenu";
import { useServerStats } from "@/hooks/useServerStats";
import { tauriCmd } from "@/lib/tauri-commands";
import {
  updateServerStatus,
  getServerModCount,
  getLastBackupTime,
  getNextScheduledRestart,
  getHasBackupEnabled,
  getAppSetting,
} from "@/lib/db";
import { applyUpdateToServer } from "@/lib/update-utils";
import { warnIfFirewallMissing } from "@/lib/firewall-utils";
import { ARK_MAPS, NOTIFICATION_EVENTS } from "@/data/game-data";
import { buildStartParams } from "@/lib/server-utils";
import { dispatchNotification } from "@/lib/notifications";
import { useQueryClient } from "@tanstack/react-query";
import { useAppStore } from "@/store/useAppStore";
import { toast } from "sonner";
import type { ServerRow } from "@/lib/db";
import { formatServerVersion } from "@/lib/db";
import { useBuildVersionCache } from "@/hooks/useBuildVersionCache";

interface Props {
  server: ServerRow;
}

// ── Utility helpers ──────────────────────────────────────────────────────────

function formatCountdown(secs: number): string {
  if (secs >= 3600) {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    return `${h}h ${m}m`;
  }
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  if (m > 0 && s > 0) return `${m}m ${s}s`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

function formatUptime(startMs: number): string {
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

function formatClockTime(iso: string | null): string {
  if (!iso) return "Not scheduled";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

// ── Main component ───────────────────────────────────────────────────────────

export function ServerCard({ server }: Props) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const stats = useServerStats(server);
  const versionCache = useBuildVersionCache();
  const startTime = useAppStore((s) => s.serverStartTimes[server.id]);
  const noRetry = useAppStore((s) => !!s.noRetryServerIds[server.id]);
  const setNoRetryServer = useAppStore((s) => s.setNoRetryServer);
  const clearNoRetryServer = useAppStore((s) => s.clearNoRetryServer);
  const isServerScanPending = useAppStore((s) => s.isServerScanPending);
  const countdown = useAppStore((s) => s.countdowns[server.id] ?? null);

  const [modCount, setModCount] = useState<number | null>(null);
  const [lastBackup, setLastBackup] = useState<string | null>(null);
  const [nextRestart, setNextRestart] = useState<string | null>(null);
  const [backupEnabled, setBackupEnabled] = useState<boolean | null>(null);
  const [actionPending, setActionPending] = useState(false);
  const [showProgress, setShowProgress] = useState(false);
  const [showUpdateConfirm, setShowUpdateConfirm] = useState(false);
  const [autoCheckEnabled, setAutoCheckEnabled] = useState(true);
  const [restartAfterUpdate, setRestartAfterUpdate] = useState(true);
  const [backupProgress, setBackupProgress] = useState<{ active: boolean; percent: number; label: string }>({
    active: false, percent: 0, label: "",
  });
  const backupProgressUpdatedAt = useRef<number>(0);
  const removeFromStartupQueue = useAppStore((s) => s.removeFromStartupQueue);

  useTauriEvent<{ percent: number; currentFile: string; label: string }>(
    `backup://progress/${server.id}`,
    (p) => {
      backupProgressUpdatedAt.current = Date.now();
      // Keep active=true even at 100% — SchedulerManager's backup:completed clears it
      setBackupProgress({ active: true, percent: p.percent, label: p.label });
    }
  );

  // Clear progress bar when Rust confirms the backup is fully recorded in DB,
  // and refresh the displayed "Last Backup" time to match.
  useTauriEvent(`backup://completed/${server.id}`, () => {
    setBackupProgress({ active: false, percent: 0, label: "" });
    getLastBackupTime(server.id).then(setLastBackup).catch(() => {});
  });

  // Fallback: clear stale progress bar if no update received in 30s.
  useEffect(() => {
    if (!backupProgress.active) return;
    const id = setInterval(() => {
      if (backupProgressUpdatedAt.current > 0 && Date.now() - backupProgressUpdatedAt.current > 30_000) {
        setBackupProgress({ active: false, percent: 0, label: "" });
      }
    }, 5_000);
    return () => clearInterval(id);
  }, [backupProgress.active]);

  const hasUpdateAvailable  = server.update_available === 1;
  const isUpdateQueued      = server.status === "update_queued";
  const isStartupQueued     = server.status === "startup_queued";

  const [, setTick] = useState(0);
  useEffect(() => {
    const active = server.status === "running" || server.status === "starting";
    if (!active) return;
    const id = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, [server.status]);

  const mapDisplay =
    ARK_MAPS.find((m) => m.id === server.map_id)?.displayName ?? server.map_id;

  const isRunning       = server.status === "running";
  const isStarting      = server.status === "starting";
  const isTransitioning = ["starting", "stopping", "updating", "update_queued"].includes(server.status);
  const isInstalling    = server.status === "installing";
  const isUpdating      = server.status === "updating";
  const isActiveInstall = isInstalling || isUpdating;
  const isInstallFailed = server.status === "install_failed";
  const isStartFailed   = server.status === "start-failed";
  const isReinstallable = isInstallFailed || isStartFailed;

  // Load secondary card data (mod count, backup, schedule, auto-check state).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [mc, lb, nr, be, autoHours] = await Promise.all([
        getServerModCount(server.id),
        getLastBackupTime(server.id),
        getNextScheduledRestart(server.id),
        getHasBackupEnabled(server.id),
        getAppSetting("asa_auto_check_hours"),
      ]);
      if (!cancelled) {
        setModCount(mc);
        setLastBackup(lb);
        setNextRestart(nr);
        setBackupEnabled(be);
        setAutoCheckEnabled((autoHours ?? "disabled") !== "disabled");
      }
    })();
    return () => { cancelled = true; };
  }, [server.id]);

  // ── Actions ──────────────────────────────────────────────────────────────

  const handleStart = async () => {
    setActionPending(true);
    clearNoRetryServer(server.id);
    try {
      await updateServerStatus(server.id, "starting", null);
      queryClient.invalidateQueries({ queryKey: ["servers"] });

      // Ensure both save symlinks/junctions are in place before launching
      const baseDir = await getAppSetting("base_dir").catch(() => null);
      if (baseDir) {
        const mapPath = ARK_MAPS.find((m) => m.id === server.map_id)?.mapPath ?? "TheIsland_WP";
        await tauriCmd.createSaveLink(server.install_path, server.id, baseDir).catch((e) => {
          console.warn("createSaveLink failed on start:", e);
        });
        await tauriCmd.createModsSavesLink(server.install_path, server.id, baseDir, mapPath).catch((e) => {
          console.warn("createModsSavesLink failed on start:", e);
        });
      }

      await warnIfFirewallMissing(server);
      const params = await buildStartParams(server);
      const pid = await tauriCmd.startServer(params);

      // Stay "starting" — Rust backend emits server://status/{id} with "running"
      // once the RCON port responds (server fully loaded and joinable).
      await updateServerStatus(server.id, "starting", pid);
      queryClient.invalidateQueries({ queryKey: ["servers"] });
    } catch (err) {
      const raw = typeof err === "string" ? err : String(err);
      const isExeMissing = raw.startsWith("exe_missing:");
      const userMsg = isExeMissing
        ? raw.slice("exe_missing: ".length)
        : raw;

      if (isExeMissing) setNoRetryServer(server.id);

      await updateServerStatus(server.id, "start-failed", null);
      queryClient.invalidateQueries({ queryKey: ["servers"] });
      toast.error(`${server.name} failed to start`, { description: userMsg });
      dispatchNotification({
        eventType:  NOTIFICATION_EVENTS.SERVER_START_FAILED,
        serverId:   server.id,
        serverName: server.name,
        title:      `${server.name} failed to start`,
        body:       userMsg,
        severity:   "error",
      });
    } finally {
      setActionPending(false);
    }
  };

  const handleStop = async () => {
    setActionPending(true);
    try {
      await updateServerStatus(server.id, "stopping", server.pid);
      queryClient.invalidateQueries({ queryKey: ["servers"] });
      await tauriCmd.gracefulStopServer(
        server.id,
        server.rcon_port,
        server.admin_password,
        server.shutdown_warn_players !== 0,
        server.shutdown_warn_minutes ?? 5,
        server.shutdown_message || "Server will shut down in {time}.",
      );
    } catch (err) {
      toast.error(`Failed to stop ${server.name}`, { description: String(err) });
    } finally {
      setActionPending(false);
    }
  };

  const handleForceStop = async () => {
    setActionPending(true);
    try {
      await tauriCmd.stopServer(server.id, false);
    } catch (err) {
      toast.error(`Force stop failed: ${err}`);
    } finally {
      setActionPending(false);
    }
  };

  const handleRestart = async () => {
    if (server.restart_warn_players) {
      const startParams = await buildStartParams(server);
      tauriCmd.startGracefulRestart({
        serverId:      server.id,
        warnSeconds:   (server.restart_warn_minutes ?? 5) * 60,
        rconPort:      server.rcon_port,
        rconPassword:  server.admin_password,
        message:       server.restart_message || "Server restarting in {time}.",
        cancelMessage: server.restart_cancel_message || "Restart has been canceled.",
        startParams,
      }).catch((err) => toast.error(`Restart failed: ${err}`));
      return;
    }

    setActionPending(true);
    try {
      await updateServerStatus(server.id, "stopping", server.pid);
      queryClient.invalidateQueries({ queryKey: ["servers"] });

      const params = await buildStartParams(server);
      const newPid = await tauriCmd.restartServer(params, true);

      await updateServerStatus(server.id, "running", newPid);
      queryClient.invalidateQueries({ queryKey: ["servers"] });
    } catch (err) {
      toast.error(`Failed to restart ${server.name}`, { description: String(err) });
      await updateServerStatus(server.id, "error", null);
      queryClient.invalidateQueries({ queryKey: ["servers"] });
    } finally {
      setActionPending(false);
    }
  };

  const handleApplyUpdate = async () => {
    setShowUpdateConfirm(false);

    if (server.update_warn_players && isRunning) {
      const [baseDir, steamcmdPath] = await Promise.all([
        getAppSetting("base_dir"),
        getAppSetting("steamcmd_path"),
      ]);
      if (!baseDir || !steamcmdPath) return;
      const sep = baseDir.includes("\\") ? "\\" : "/";
      const cacheDir = `${baseDir.replace(/[/\\]$/, "")}${sep}lokiasam${sep}cache${sep}asa-server`;
      const startParams = restartAfterUpdate ? await buildStartParams(server) : null;

      tauriCmd.startGracefulUpdate({
        serverId:      server.id,
        serverName:    server.name,
        warnSeconds:   (server.update_warn_minutes ?? 5) * 60,
        rconPort:      server.rcon_port,
        rconPassword:  server.admin_password,
        message:       server.update_message || "Server going down for update in {time}.",
        cancelMessage: server.update_cancel_message || "Update has been canceled.",
        installPath:   server.install_path,
        cacheDir,
        steamcmdPath,
        restartAfter:  restartAfterUpdate,
        startParams,
      }).catch((err) => toast.error(`Update failed: ${err}`));
      return;
    }

    setActionPending(true);
    try {
      const wasRunning = isRunning;
      try {
        await applyUpdateToServer(
          server.id,
          server.name,
          server.install_path,
          wasRunning,
          restartAfterUpdate,
          server.rcon_port,
          server.admin_password,
          {
            // This branch only runs when the warn-players countdown path above
            // wasn't taken (warn disabled, or server wasn't running) — still
            // always saves the world and shuts down cleanly via RCON either way.
            warnPlayers: false,
            warnMinutes: server.update_warn_minutes ?? 5,
            warnMessage: server.update_message || "Server going down for update in {time}.",
          },
          (msg) => toast.info(msg),
        );
      } catch (err) {
        if (err && typeof err === "object" && "restartNeeded" in err) {
          await handleStart();
          return;
        }
        throw err;
      }
      queryClient.invalidateQueries({ queryKey: ["servers"] });
      toast.success(`${server.name} updated successfully.`);
    } catch (e) {
      toast.error(`Update failed: ${e}`);
    } finally {
      setActionPending(false);
      queryClient.invalidateQueries({ queryKey: ["servers"] });
    }
  };

  const handleReinstall = async () => {
    try {
      const [baseDir, steamcmdPath] = await Promise.all([
        getAppSetting("base_dir"),
        getAppSetting("steamcmd_path"),
      ]);
      if (!baseDir || !steamcmdPath) return;
      const sep = baseDir.includes("\\") ? "\\" : "/";
      const cacheDir = `${baseDir.replace(/[/\\]$/, "")}${sep}lokiasam${sep}cache${sep}asa-server`;

      await updateServerStatus(server.id, "installing", null);
      queryClient.invalidateQueries({ queryKey: ["servers"] });
      setShowProgress(true);

      try {
        await tauriCmd.updateServer(server.id, server.install_path, cacheDir, steamcmdPath);

        // Import ARK_MAPS for map path lookup
        const { ARK_MAPS } = await import("@/data/game-data");
        const mapPath = ARK_MAPS.find((m) => m.id === server.map_id)?.mapPath ?? "TheIsland_WP";

        await tauriCmd.createSaveLink(server.install_path, server.id, baseDir).catch((e) => {
          console.warn("createSaveLink failed after reinstall:", e);
        });
        await tauriCmd.createModsSavesLink(server.install_path, server.id, baseDir, mapPath).catch((e) => {
          console.warn("createModsSavesLink failed after update:", e);
        });
        await updateServerStatus(server.id, "stopped", null);
        dispatchNotification({
          eventType:  NOTIFICATION_EVENTS.SERVER_INSTALL_COMPLETE,
          serverId:   server.id,
          serverName: server.name,
          title:      `${server.name} installed successfully`,
          body:       "Server files are ready. You can start the server now.",
          severity:   "success",
        });
      } catch {
        await updateServerStatus(server.id, "install_failed", null).catch(() => {});
        dispatchNotification({
          eventType:  NOTIFICATION_EVENTS.SERVER_INSTALL_FAILED,
          serverId:   server.id,
          serverName: server.name,
          title:      `${server.name} install failed`,
          body:       "The server installation was canceled or failed.",
          severity:   "error",
        });
      }
      queryClient.invalidateQueries({ queryKey: ["servers"] });
    } catch {
      // Settings unavailable — cannot reinstall
    }
  };

  // ── Border glow based on status ───────────────────────────────────────────

  const borderColor = isRunning
    ? "rgba(0,255,136,0.35)"
    : server.status === "error" || server.status === "crashed" || isReinstallable
    ? "rgba(255,0,85,0.35)"
    : "rgba(var(--neon-purple-rgb),0.2)";

  return (
    <div
      className="glass-card flex flex-col gap-4 p-5 rounded-2xl transition-all duration-300 cursor-pointer"
      style={{
        border: `1px solid ${borderColor}`,
        boxShadow: isRunning
          ? "0 0 20px rgba(0,255,136,0.08)"
          : server.status === "error" || server.status === "crashed"
          ? "0 0 20px rgba(255,0,85,0.08)"
          : undefined,
      }}
      onClick={(e) => {
        if (!(e.target as HTMLElement).closest('button, a, [role="menuitem"], [data-radix-collection-item], [role="dialog"], [role="alertdialog"]')) {
          router.push(`/servers/detail?id=${server.id}`);
        }
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
            <ServerStatusBadge
              status={isServerScanPending ? "detecting" : server.status}
              countdownLabel={countdown
                ? countdown.action === "restart"
                  ? `Restarting in ${formatCountdown(countdown.remainingSecs)}`
                  : `Updating in ${formatCountdown(countdown.remainingSecs)}`
                : undefined}
            />
          </div>
          <div
            className="flex items-center gap-1 mt-1 text-xs"
            style={{ color: "var(--text-muted)" }}
          >
            <Map className="w-3 h-3 shrink-0" />
            <span>{mapDisplay}</span>
            <span className="mx-1 opacity-40">·</span>
            <span>:{server.port}</span>
            {server.installed_build_id && (
              <>
                <span className="mx-1 opacity-40">·</span>
                <span className="font-mono">{formatServerVersion(server.installed_build_id, versionCache)}</span>
              </>
            )}
          </div>
        </div>
        <ServerActionMenu
          server={server}
          onBackupComplete={() => { getLastBackupTime(server.id).then(setLastBackup).catch(() => {}); }}
        />
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
            {server.status === "starting" ? "Starting" : "Uptime"}
          </span>
          <span className="text-xs font-semibold ml-auto" style={{ color: "var(--text-primary)" }}>
            {startTime != null
              ? formatUptime(startTime)
              : (isRunning ? formatUptime(new Date(server.updated_at).getTime()) : "—")}
          </span>
        </div>

        {/* CPU */}
        <div className="flex items-center gap-2">
          <Cpu className="w-3.5 h-3.5 shrink-0" style={{ color: "var(--neon-green)" }} />
          <span className="text-xs" style={{ color: "var(--text-muted)" }}>
            CPU
          </span>
          <span className="text-xs font-semibold ml-auto" style={{ color: "var(--text-primary)" }}>
            {(isRunning || server.status === "starting") && stats.cpuPercent !== null
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
            {(isRunning || server.status === "starting") && stats.memoryMb !== null
              ? `${(stats.memoryMb / 1024).toFixed(2)} GB`
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
          <span className="text-xs" style={{ color: "var(--text-muted)" }}>Backup</span>
          <span className="text-xs font-semibold ml-auto" style={{ color: "var(--text-primary)" }}>
            {formatRelativeTime(lastBackup)}
          </span>
        </div>
        {backupProgress.active && (
          <div className="col-span-2 flex items-center gap-2">
            <div className="flex-1 h-1 rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,0.06)" }}>
              <div
                className="h-full rounded-full transition-all duration-300"
                style={{
                  width: `${backupProgress.percent}%`,
                  background: "linear-gradient(90deg, var(--neon-purple), var(--neon-cyan))",
                  boxShadow: "0 0 6px rgba(var(--neon-purple-rgb),0.5)",
                }}
              />
            </div>
            <span className="text-xs tabular-nums shrink-0" style={{ color: "var(--neon-purple)" }}>
              {backupProgress.percent.toFixed(0)}%
            </span>
          </div>
        )}
      </div>

      {/* Next restart · Backup status */}
      {(nextRestart || backupEnabled !== null || backupProgress.active) && (
        <div className="flex items-center gap-3 flex-wrap text-xs" style={{ color: "var(--text-muted)" }}>
          {nextRestart && (
            <span>
              Next restart:{" "}
              <span style={{ color: "var(--neon-purple)" }}>{formatClockTime(nextRestart)}</span>
            </span>
          )}
          {nextRestart && (backupEnabled !== null || backupProgress.active) && (
            <span className="opacity-40">·</span>
          )}
          {(backupEnabled !== null || backupProgress.active) && (
            <span>
              {backupProgress.active
                ? <span style={{ color: "var(--neon-purple)" }}>Backup in progress</span>
                : backupEnabled
                  ? <span style={{ color: "var(--neon-purple)" }}>Backup enabled</span>
                  : <span className="opacity-50">Backup disabled</span>
              }
            </span>
          )}
        </div>
      )}

      {/* ── Action buttons ── */}
      {/* Two non-wrapping groups: left (status-dependent) + right (nav arrow).
          This prevents the arrow from shifting when left-side buttons change. */}
      <div className="flex items-center gap-2 pt-1 border-t overflow-hidden mt-auto" style={{ borderColor: "rgba(var(--neon-purple-rgb),0.1)" }}>

        {/* Left: all status-dependent actions */}
        <div className="flex items-center gap-2 flex-1 min-w-0">
          {countdown ? (
            <>
              <Button
                size="sm"
                onClick={() => tauriCmd.proceedNow(server.id).catch(() => {})}
                className="gap-1.5 flex-1"
                style={{ background: "rgba(255,140,0,0.12)", borderColor: "rgba(255,140,0,0.4)", color: "#ff8c00" }}
              >
                {countdown.action === "restart"
                  ? <><RotateCcw className="w-3.5 h-3.5" /> Restart Now</>
                  : <><ArrowUp className="w-3.5 h-3.5" /> Update Now</>}
              </Button>
              <Button
                size="sm" variant="outline"
                onClick={() => tauriCmd.cancelCountdown(server.id).catch(() => {})}
                className="gap-1.5"
                style={{ color: "var(--neon-red)", borderColor: "rgba(255,0,85,0.3)" }}
              >
                <X className="w-3.5 h-3.5" /> Cancel
              </Button>
            </>
          ) : isActiveInstall ? (
            <>
              <Button
                size="sm" variant="outline"
                onClick={async () => {
                  await tauriCmd.abortOperation(`server_${server.id}`).catch(() => {});
                  await updateServerStatus(server.id, "install_failed", null).catch(() => {});
                  queryClient.invalidateQueries({ queryKey: ["servers"] });
                }}
                className="gap-1.5"
                style={{ color: "var(--neon-red)", borderColor: "rgba(255,0,85,0.3)" }}
              >
                <XCircle className="w-3.5 h-3.5" /> Cancel
              </Button>
              <Button
                size="sm" variant="outline" onClick={() => setShowProgress(true)}
                className="gap-1.5 flex-1"
                style={{ color: "var(--neon-purple)", borderColor: "rgba(var(--neon-purple-rgb),0.3)" }}
              >
                <Terminal className="w-3.5 h-3.5" /> View Progress
              </Button>
            </>
          ) : isUpdateQueued ? (
            <>
              <span className="text-xs flex items-center gap-1" style={{ color: "#ffa500" }}>
                <Loader2 className="w-3 h-3" /> Update queued
              </span>
              <Button
                size="sm" variant="outline"
                onClick={async () => {
                  await updateServerStatus(server.id, "stopped", null);
                  queryClient.invalidateQueries({ queryKey: ["servers"] });
                }}
                className="gap-1.5 ml-auto"
                style={{ color: "var(--text-muted)", borderColor: "rgba(var(--neon-purple-rgb),0.2)" }}
              >
                <Ban className="w-3.5 h-3.5" /> Cancel
              </Button>
            </>
          ) : isStartupQueued ? (
            <>
              <span className="text-xs flex items-center gap-1" style={{ color: "var(--neon-cyan)" }}>
                <Loader2 className="w-3 h-3" /> Startup queued
              </span>
              <Button
                size="sm" variant="outline"
                onClick={async () => {
                  removeFromStartupQueue(server.id);
                  await updateServerStatus(server.id, "stopped", null);
                  queryClient.invalidateQueries({ queryKey: ["servers"] });
                }}
                className="gap-1.5 ml-auto"
                style={{ color: "var(--text-muted)", borderColor: "rgba(var(--neon-purple-rgb),0.2)" }}
              >
                <Ban className="w-3.5 h-3.5" /> Cancel
              </Button>
            </>
          ) : isReinstallable ? (
            <>
              <div className="flex items-center gap-1.5 text-xs" style={{ color: "var(--neon-red)" }}>
                <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                {isInstallFailed ? "Install Failed" : "Start Failed"}
              </div>
              {isStartFailed && !noRetry && (
                <Button
                  size="sm" disabled={actionPending} onClick={handleStart} className="gap-1.5"
                  style={{ background: "rgba(0,255,136,0.12)", borderColor: "rgba(0,255,136,0.4)", color: "var(--neon-green)" }}
                >
                  <Play className="w-3.5 h-3.5" /> Retry
                </Button>
              )}
              <Button
                size="sm" variant="outline" onClick={handleReinstall} className="gap-1.5 flex-1"
                style={{ color: "var(--neon-purple)", borderColor: "rgba(var(--neon-purple-rgb),0.3)" }}
              >
                <RotateCcw className="w-3.5 h-3.5" /> Reinstall
              </Button>
            </>
          ) : isServerScanPending ? (
            <Button size="sm" disabled className="gap-1.5 flex-1">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Detecting...
            </Button>
          ) : (
            <>
              {/* Primary status button — always flex-1 so width is consistent */}
              {server.status === "stopping" ? (
                <Button
                  size="sm" onClick={handleForceStop} className="gap-1.5 flex-1"
                  style={{ background: "rgba(255,100,0,0.12)", borderColor: "rgba(255,100,0,0.4)", color: "#ff6400" }}
                >
                  <Loader2 className="w-3.5 h-3.5 animate-spin" /> Force Stop
                </Button>
              ) : isStarting ? (
                <Button
                  size="sm" onClick={handleForceStop} className="gap-1.5 flex-1"
                  style={{ background: "rgba(255,200,0,0.12)", borderColor: "rgba(255,200,0,0.4)", color: "#ffc800" }}
                >
                  <X className="w-3.5 h-3.5" /> Cancel Startup
                </Button>
              ) : isRunning ? (
                <Button
                  size="sm" disabled={actionPending} onClick={handleStop} className="gap-1.5 flex-1"
                  style={{ background: "rgba(255,0,85,0.12)", borderColor: "rgba(255,0,85,0.4)", color: "var(--neon-red)" }}
                >
                  <Square className="w-3.5 h-3.5" /> Stop
                </Button>
              ) : (
                <Button
                  size="sm" disabled={actionPending} onClick={handleStart} className="gap-1.5 flex-1"
                  style={{ background: "rgba(0,255,136,0.12)", borderColor: "rgba(0,255,136,0.4)", color: "var(--neon-green)" }}
                >
                  <Play className="w-3.5 h-3.5" /> Start
                </Button>
              )}

              {isRunning && (
                <Button
                  size="sm" variant="outline" disabled={actionPending} onClick={handleRestart} className="gap-1.5"
                  style={{ color: "var(--neon-purple)", borderColor: "rgba(var(--neon-purple-rgb),0.3)" }}
                >
                  <RotateCcw className="w-3.5 h-3.5" /> Restart
                </Button>
              )}

              {hasUpdateAvailable && (
                <Button
                  size="sm"
                  disabled={actionPending || !autoCheckEnabled || isTransitioning || isStarting}
                  onClick={() => autoCheckEnabled && setShowUpdateConfirm(true)}
                  title={!autoCheckEnabled ? "Enable auto update checks in Settings" : undefined}
                  className="gap-1.5"
                  style={{
                    background:   autoCheckEnabled ? "rgba(255,165,0,0.12)" : "rgba(255,165,0,0.04)",
                    borderColor:  autoCheckEnabled ? "rgba(255,165,0,0.5)"  : "rgba(255,165,0,0.2)",
                    color:        autoCheckEnabled ? "#ffa500"              : "rgba(255,165,0,0.4)",
                  }}
                >
                  <ArrowUp className="w-3.5 h-3.5" /> Update
                </Button>
              )}
            </>
          )}
        </div>

        {/* Right: detail arrow — never moves */}
        <Button
          asChild size="sm" variant="outline"
          className="gap-1 shrink-0 ml-auto"
          style={{ color: "var(--neon-cyan)", borderColor: "rgba(var(--neon-purple-rgb),0.3)" }}
        >
          <Link href={`/servers/detail?id=${server.id}`}>
            <ChevronRight className="w-3.5 h-3.5" />
          </Link>
        </Button>
      </div>

      {/* ── Update confirmation dialog ── */}
      <Dialog open={showUpdateConfirm} onOpenChange={setShowUpdateConfirm}>
        <DialogContent className="max-w-sm" onClick={(e) => e.stopPropagation()}>
          <DialogHeader>
            <DialogTitle>Apply Server Update?</DialogTitle>
            <DialogDescription>
              {isRunning
                ? `${server.name} is currently running and will be stopped to apply the update.`
                : `${server.name} will be updated from the shared cache.`}
            </DialogDescription>
          </DialogHeader>

          {isRunning && (
            <div
              className="flex items-center justify-between px-1 py-2 rounded-lg"
              style={{ background: "rgba(255,165,0,0.05)", border: "1px solid rgba(255,165,0,0.15)" }}
            >
              <p className="text-sm" style={{ color: "var(--text-primary)" }}>
                Restart server after update
              </p>
              <button
                type="button"
                onClick={() => setRestartAfterUpdate((v) => !v)}
                className="shrink-0 flex items-center focus:outline-none"
                aria-label={restartAfterUpdate ? "Disable restart after update" : "Enable restart after update"}
              >
                {restartAfterUpdate
                  ? <ToggleRight className="w-8 h-8" style={{ color: "var(--neon-purple)" }} />
                  : <ToggleLeft className="w-8 h-8" style={{ color: "var(--text-muted)" }} />}
              </button>
            </div>
          )}

          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setShowUpdateConfirm(false)}
              style={{ borderColor: "rgba(var(--neon-purple-rgb),0.3)", color: "var(--text-muted)" }}>
              Cancel
            </Button>
            <Button onClick={handleApplyUpdate}
              style={{ background: "rgba(255,165,0,0.15)", borderColor: "rgba(255,165,0,0.5)", color: "#ffa500" }}>
              <ArrowUp className="w-3.5 h-3.5 mr-1.5" /> Update
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── View Progress modal ── */}
      <Dialog
        open={showProgress}
        onOpenChange={(open) => {
          if (!open && !isActiveInstall) {
            // Clear the output buffer when closing after process is done
            clearOutputBuffer(`steamcmd://output/${server.id}`);
          }
          setShowProgress(open);
        }}
      >
        <DialogContent showCloseButton={false} className="max-w-6xl w-full">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {isActiveInstall && (
                <Loader2 className="w-4 h-4 animate-spin" style={{ color: "var(--neon-purple)" }} />
              )}
              {isUpdating ? "Update Progress" : "Install Progress"} — {server.name}
            </DialogTitle>
            <DialogDescription className="sr-only">
              Live terminal output for the {isUpdating ? "update" : "install"} process for {server.name}.
            </DialogDescription>
          </DialogHeader>
          {showProgress && (
            <CommandOutputPanel
              eventChannel={`steamcmd://output/${server.id}`}
              label={isUpdating ? "Update Output" : "Install Output"}
              bodyClassName="h-96"
              completed={!isActiveInstall && server.status === "stopped"}
              canceled={!isActiveInstall && isInstallFailed}
            />
          )}
          <DialogFooter>
            {isActiveInstall && (
              <Button
                variant="outline"
                onClick={async () => {
                  await tauriCmd.abortOperation(`server_${server.id}`).catch(() => {});
                  await updateServerStatus(server.id, "install_failed", null).catch(() => {});
                  queryClient.invalidateQueries({ queryKey: ["servers"] });
                  setShowProgress(false);
                }}
                style={{ color: "var(--neon-red)", borderColor: "rgba(255,0,85,0.3)" }}
              >
                Cancel Install
              </Button>
            )}
            <Button
              variant={isActiveInstall ? "outline" : "default"}
              onClick={() => {
                if (!isActiveInstall) {
                  clearOutputBuffer(`steamcmd://output/${server.id}`);
                }
                setShowProgress(false);
              }}
              style={isActiveInstall ? { color: "var(--neon-purple)", borderColor: "rgba(var(--neon-purple-rgb),0.3)" } : undefined}
            >
              {isActiveInstall ? "Continue in Background" : "Close"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
