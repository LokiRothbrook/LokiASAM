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
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { CommandOutputPanel, clearOutputBuffer } from "@/components/shared/CommandOutputPanel";
import { ServerStatusBadge } from "./ServerStatusBadge";
import { ServerActionMenu } from "./ServerActionMenu";
import { useServerStats } from "@/hooks/useServerStats";
import { tauriCmd, type StartServerParams } from "@/lib/tauri-commands";
import {
  updateServerStatus,
  getServerConfig,
  getServerModCount,
  getServerMods,
  getLastBackupTime,
  getNextScheduledRestart,
  getNextScheduledBackup,
  getAppSetting,
  resetServersFromStatus,
} from "@/lib/db";
import { applyUpdateToServer } from "@/lib/update-utils";
import { warnIfFirewallMissing } from "@/lib/firewall-utils";
import { ARK_MAPS, LAUNCH_PARAMETERS, NOTIFICATION_EVENTS } from "@/data/game-data";
import { dispatchNotification } from "@/lib/notifications";
import { useQueryClient } from "@tanstack/react-query";
import { useAppStore } from "@/store/useAppStore";
import { toast } from "sonner";
import type { ServerRow } from "@/lib/db";

interface Props {
  server: ServerRow;
}

// ── Utility helpers ──────────────────────────────────────────────────────────

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
  const router = useRouter();
  const queryClient = useQueryClient();
  const stats = useServerStats(server);
  const startTime = useAppStore((s) => s.serverStartTimes[server.id]);
  const noRetry = useAppStore((s) => !!s.noRetryServerIds[server.id]);
  const setNoRetryServer = useAppStore((s) => s.setNoRetryServer);
  const clearNoRetryServer = useAppStore((s) => s.clearNoRetryServer);
  const isServerScanPending = useAppStore((s) => s.isServerScanPending);

  const [modCount, setModCount] = useState<number | null>(null);
  const [lastBackup, setLastBackup] = useState<string | null>(null);
  const [nextRestart, setNextRestart] = useState<string | null>(null);
  const [nextBackup, setNextBackup] = useState<string | null>(null);
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
      setBackupProgress({ active: p.percent < 100, percent: p.percent, label: p.label });
    }
  );

  // Clear stale progress bar if no update received in 30s.
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
      const [mc, lb, nr, nb, autoHours] = await Promise.all([
        getServerModCount(server.id),
        getLastBackupTime(server.id),
        getNextScheduledRestart(server.id),
        getNextScheduledBackup(server.id),
        getAppSetting("asa_auto_check_hours"),
      ]);
      if (!cancelled) {
        setModCount(mc);
        setLastBackup(lb);
        setNextRestart(nr);
        setNextBackup(nb);
        setAutoCheckEnabled((autoHours ?? "0") !== "0");
      }
    })();
    return () => { cancelled = true; };
  }, [server.id]);

  // ── Actions ──────────────────────────────────────────────────────────────

  const isLinux =
    typeof navigator !== "undefined" && !navigator.userAgent.includes("Windows");

  const buildStartParams = async (): Promise<StartServerParams> => {
    const [config, mods] = await Promise.all([
      getServerConfig(server.id),
      getServerMods(server.id),
    ]);
    const launchArgs: Record<string, string> = config
      ? JSON.parse(config.launch_args_json)
      : {};

    const extraArgs = Object.entries(launchArgs).flatMap(([k, v]) => {
      if (!v || v === "false" || v === "0") return [];
      const param = LAUNCH_PARAMETERS.find((p) => p.key === k);
      if (param?.type === "boolean") return v === "true" ? [param.flag] : [];
      if (param) return v ? [`${param.flag}${v}`] : [];
      return v === "true" ? [`-${k}`] : [`-${k}=${v}`];
    });

    const map = ARK_MAPS.find((m) => m.id === server.map_id);
    const enabledModIds = mods.filter((m) => m.enabled === 1).map((m) => m.mod_id);

    const params: StartServerParams = {
      serverId: server.id,
      serverName: server.name,
      installPath: server.install_path,
      mapPath: map?.mapPath ?? "TheIsland_WP",
      port: server.port,
      queryPort: server.query_port,
      rconPort: server.rcon_port,
      extraArgs,
      modIds: enabledModIds,
    };

    if (isLinux) {
      params.protonPath = (await getAppSetting("proton_path")) ?? undefined;
      params.prefixPath = (await getAppSetting("proton_prefix_path")) ?? undefined;
    }

    return params;
  };

  const handleStart = async () => {
    setActionPending(true);
    clearNoRetryServer(server.id);
    try {
      await updateServerStatus(server.id, "starting", null);
      queryClient.invalidateQueries({ queryKey: ["servers"] });

      await warnIfFirewallMissing(server);
      const params = await buildStartParams();
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
        server.rcon_password,
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
    setActionPending(true);
    try {
      await updateServerStatus(server.id, "stopping", server.pid);
      queryClient.invalidateQueries({ queryKey: ["servers"] });

      const params = await buildStartParams();
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
        if (!(e.target as HTMLElement).closest('button, a, [role="menuitem"], [data-radix-collection-item]')) {
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
            <ServerStatusBadge status={isServerScanPending ? "detecting" : server.status} />
            {hasUpdateAvailable && (
              <span
                className="flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium"
                style={{ background: "rgba(255,165,0,0.1)", border: "1px solid rgba(255,165,0,0.4)", color: "#ffa500" }}
              >
                <ArrowUp className="w-2.5 h-2.5" />
                Update
              </span>
            )}
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

      {/* Next restart / next backup */}
      {(nextRestart || nextBackup || backupProgress.active) && (
        <div className="flex items-center gap-3 flex-wrap text-xs" style={{ color: "var(--text-muted)" }}>
          {nextRestart && (
            <span>
              Next restart:{" "}
              <span style={{ color: "var(--neon-purple)" }}>{formatFutureTime(nextRestart)}</span>
            </span>
          )}
          {nextRestart && (nextBackup || backupProgress.active) && <span className="opacity-40">·</span>}
          {(nextBackup || backupProgress.active) && (
            <span>
              {backupProgress.active
                ? <span style={{ color: "var(--neon-purple)" }}>Backup in progress</span>
                : <>Next backup:{" "}<span style={{ color: "var(--neon-purple)" }}>{formatFutureTime(nextBackup)}</span></>
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
          {isActiveInstall ? (
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
        <DialogContent className="max-w-sm">
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
              className="flex items-center gap-3 px-1 py-2 rounded-lg"
              style={{ background: "rgba(255,165,0,0.05)", border: "1px solid rgba(255,165,0,0.15)" }}
            >
              <Switch
                id={`sc-restart-toggle-${server.id}`}
                checked={restartAfterUpdate}
                onCheckedChange={setRestartAfterUpdate}
              />
              <Label htmlFor={`sc-restart-toggle-${server.id}`} className="text-sm cursor-pointer" style={{ color: "var(--text-primary)" }}>
                Restart server after update
              </Label>
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
