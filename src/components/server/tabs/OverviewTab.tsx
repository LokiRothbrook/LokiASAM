"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  Play, Square, RotateCcw, Users, Cpu, MemoryStick, Clock,
  Save, RefreshCw, ArrowUp, Loader2, X, BarChart2, FolderOpen,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogDescription,
  DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  ResponsiveContainer, ComposedChart, Area, Line,
  XAxis, YAxis, CartesianGrid, Tooltip,
} from "recharts";
import { useServerStats } from "@/hooks/useServerStats";
import { useServerStatsHistory, type Timeframe } from "@/hooks/useServerStatsHistory";
import { tauriCmd, type StartServerParams, type ArkPlayer } from "@/lib/tauri-commands";
import { useAppStore } from "@/store/useAppStore";
import {
  updateServerStatus, getServerConfig, getServerModCount, getServerMods,
  getLastBackupTime, getNextScheduledRestart, getHasBackupEnabled, getAppSetting, insertBackup,
  pruneManualBackups, setServerAutoStart,
} from "@/lib/db";
import { applyUpdateToServer } from "@/lib/update-utils";
import { warnIfFirewallMissing } from "@/lib/firewall-utils";
import type { BackupRecord } from "@/lib/tauri-commands";
import type { ServerRow } from "@/lib/db";
import { toast } from "sonner";
import { ARK_MAPS, LAUNCH_PARAMETERS, NOTIFICATION_EVENTS } from "@/data/game-data";
import { dispatchNotification } from "@/lib/notifications";
import { useQueryClient } from "@tanstack/react-query";
import { useTauriEvent } from "@/hooks/useTauriEvent";

interface Props {
  server: ServerRow;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const TIMEFRAMES: Timeframe[] = ["Live", "1H", "6H", "24H", "7D", "30D", "3M", "6M", "1Y"];

const METRIC_CONFIG = {
  cpu:     { color: "var(--neon-green)",  avgKey: "cpu",     maxKey: "cpuMax"     },
  mem:     { color: "var(--neon-purple)", avgKey: "mem",     maxKey: "memMax"     },
  players: { color: "var(--neon-cyan)",   avgKey: "players", maxKey: "playersMax" },
} as const;

// ── Helpers ───────────────────────────────────────────────────────────────────

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
  const diffMins = Math.floor(Math.abs(Date.now() - d.getTime()) / 60_000);
  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  const h = Math.floor(diffMins / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// ── TimeframeSelect ───────────────────────────────────────────────────────────

function TimeframeSelect({
  value,
  onChange,
}: {
  value: Timeframe;
  onChange: (t: Timeframe) => void;
}) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as Timeframe)}>
      <SelectTrigger
        size="sm"
        className="h-6 w-17 text-xs border-0 px-2 gap-1"
        style={{
          background: "rgba(var(--neon-purple-rgb),0.08)",
          border: "1px solid rgba(var(--neon-purple-rgb),0.25)",
          color: "var(--neon-purple)",
        }}
        // Prevent tile-level click handlers from seeing this interaction
        onClick={(e) => e.stopPropagation()}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {TIMEFRAMES.map((t) => (
          <SelectItem key={t} value={t} className="text-xs">
            {t}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// ── Chart tooltip ─────────────────────────────────────────────────────────────

function ChartTooltip({
  active,
  payload,
  label,
  metric,
  timeframe,
}: {
  active?: boolean;
  payload?: { value: number | null; name: string; color: string }[];
  label?: number;
  metric: "cpu" | "mem" | "players";
  timeframe: Timeframe;
}) {
  if (!active || !payload?.length || label == null) return null;

  const formatTs = (ts: number) => {
    const d = new Date(ts);
    if (timeframe === "Live" || timeframe === "1H" || timeframe === "6H" || timeframe === "24H") {
      return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }
    if (timeframe === "7D" || timeframe === "30D") {
      return `${d.getMonth() + 1}/${d.getDate()} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
    }
    return `${d.getMonth() + 1}/${d.getDate()}`;
  };

  const formatVal = (v: number | null) => {
    if (v == null) return "—";
    if (metric === "cpu") return `${v.toFixed(1)}%`;
    if (metric === "mem") return `${(v / 1024).toFixed(2)} GB`;
    return String(Math.round(v));
  };

  return (
    <div
      className="rounded-lg px-3 py-2 text-xs"
      style={{
        background: "rgba(10,10,30,0.95)",
        border: "1px solid rgba(var(--neon-purple-rgb),0.25)",
        color: "var(--text-primary)",
      }}
    >
      <div className="mb-1" style={{ color: "var(--text-muted)" }}>{formatTs(label)}</div>
      {payload.map((p) => (
        <div key={p.name} className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full inline-block shrink-0" style={{ background: p.color }} />
          <span style={{ color: "var(--text-muted)" }}>{p.name === "avg" ? "Avg" : "Peak"}:</span>
          <span className="font-semibold">{formatVal(p.value)}</span>
        </div>
      ))}
    </div>
  );
}

// ── StatChart ─────────────────────────────────────────────────────────────────

function StatChart({
  serverId,
  metric,
  timeframe,
}: {
  serverId: string;
  metric: "cpu" | "mem" | "players";
  timeframe: Timeframe;
}) {
  const { data, loading } = useServerStatsHistory(serverId, timeframe);
  const cfg = METRIC_CONFIG[metric];

  const formatTick = (ts: number) => {
    const d = new Date(ts);
    if (timeframe === "Live" || timeframe === "1H" || timeframe === "6H") {
      return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }
    if (timeframe === "24H" || timeframe === "7D" || timeframe === "30D") {
      return `${d.getMonth() + 1}/${d.getDate()}`;
    }
    return `${d.getMonth() + 1}/${d.getDate()}`;
  };

  const formatYTick = (v: number) => {
    if (metric === "mem") return `${(v / 1024).toFixed(1)}G`;
    if (metric === "cpu") return `${v.toFixed(0)}%`;
    return String(Math.round(v));
  };

  const chartData = data.map((p) => ({
    ts:  p.ts,
    avg: p[cfg.avgKey as keyof typeof p] as number | null,
    max: p[cfg.maxKey as keyof typeof p] as number | null,
  }));

  const hasData = chartData.some((d) => d.avg != null);
  const showMax = timeframe !== "Live" && chartData.some((d) => d.max != null && d.max !== d.avg);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-36" style={{ color: "var(--text-muted)" }}>
        <Loader2 className="w-4 h-4 animate-spin mr-2" />
        <span className="text-xs">Loading…</span>
      </div>
    );
  }

  if (!hasData) {
    return (
      <div className="flex flex-col items-center justify-center h-36 gap-1.5" style={{ color: "var(--text-muted)" }}>
        <BarChart2 className="w-5 h-5 opacity-25" />
        <span className="text-xs opacity-60">No data yet</span>
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={144}>
      <ComposedChart data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" vertical={false} />
        <XAxis
          dataKey="ts"
          tickFormatter={formatTick}
          tick={{ fill: "var(--text-muted)", fontSize: 9 }}
          axisLine={false}
          tickLine={false}
          minTickGap={48}
        />
        <YAxis
          tickFormatter={formatYTick}
          tick={{ fill: "var(--text-muted)", fontSize: 9 }}
          axisLine={false}
          tickLine={false}
          width={34}
        />
        <Tooltip
          content={(props) => (
            <ChartTooltip
              active={props.active}
              payload={props.payload as unknown as { value: number | null; name: string; color: string }[]}
              label={props.label as number}
              metric={metric}
              timeframe={timeframe}
            />
          )}
        />
        <Area
          type="monotone"
          dataKey="avg"
          name="avg"
          stroke={cfg.color}
          strokeWidth={1.5}
          fill={cfg.color}
          fillOpacity={0.07}
          dot={false}
          connectNulls={false}
          isAnimationActive={timeframe !== "Live"}
        />
        {showMax && (
          <Line
            type="monotone"
            dataKey="max"
            name="max"
            stroke={cfg.color}
            strokeWidth={1}
            strokeDasharray="4 2"
            strokeOpacity={0.45}
            dot={false}
            connectNulls={false}
          />
        )}
      </ComposedChart>
    </ResponsiveContainer>
  );
}

// ── ServerSummaryPanel ────────────────────────────────────────────────────────

function formatClockTime(iso: string | null): string {
  if (!iso) return "Not scheduled";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function ServerSummaryPanel({
  server,
  startTime,
  modCount,
  lastBackup,
  nextRestart,
  backupEnabled,
  onAutoStartChange,
}: {
  server: ServerRow;
  startTime: number | undefined;
  modCount: number | null;
  lastBackup: string | null;
  nextRestart: string | null;
  backupEnabled: boolean | null;
  onAutoStartChange: (v: boolean) => void;
}) {
  const isRunning = server.status === "running" || server.status === "starting";
  const currentStartMs = startTime ?? (isRunning ? new Date(server.updated_at).getTime() : null);

  const [backupActive, setBackupActive] = useState(false);
  const backupUpdatedAt = useRef<number>(0);

  useTauriEvent<{ percent: number; currentFile: string; label: string }>(
    `backup://progress/${server.id}`,
    (p) => {
      backupUpdatedAt.current = Date.now();
      setBackupActive(p.percent < 100);
    }
  );

  useEffect(() => {
    if (!backupActive) return;
    const id = setInterval(() => {
      if (backupUpdatedAt.current > 0 && Date.now() - backupUpdatedAt.current > 30_000) {
        setBackupActive(false);
      }
    }, 5_000);
    return () => clearInterval(id);
  }, [backupActive]);

  const fmtDate = (ms: number) =>
    new Date(ms).toLocaleString([], {
      month: "short", day: "numeric",
      hour: "2-digit", minute: "2-digit",
    });

  const mapDisplay = ARK_MAPS.find((m) => m.id === server.map_id)?.displayName ?? server.map_id;

  const items = [
    { label: "Started",       value: currentStartMs ? fmtDate(currentStartMs) : "—"   },
    { label: "Map",           value: mapDisplay                                         },
    { label: "Mods",          value: modCount !== null ? String(modCount) : "—"        },
    { label: "Last Backup",   value: formatRelativeTime(lastBackup)                    },
    { label: "Backup",        value: backupActive ? "In progress…" : backupEnabled === null ? "—" : backupEnabled ? "Enabled" : "Disabled" },
    { label: "Next Restart",  value: formatClockTime(nextRestart)                      },
  ];

  return (
    <div className="flex flex-col gap-3 pt-1">
      <div className="grid grid-cols-2 gap-x-4 gap-y-3">
        {items.map(({ label, value }) => (
          <div key={label}>
            <div className="text-xs mb-0.5" style={{ color: "var(--text-muted)" }}>{label}</div>
            <div className="text-sm font-semibold truncate" style={{ color: "var(--text-primary)" }}>{value}</div>
          </div>
        ))}
      </div>

      {/* Auto-start toggle */}
      <div
        className="flex items-center gap-3 pt-2"
        style={{ borderTop: "1px solid rgba(255,255,255,0.05)" }}
      >
        <Switch
          id={`auto-start-${server.id}`}
          checked={server.auto_start === 1}
          onCheckedChange={onAutoStartChange}
        />
        <div>
          <Label htmlFor={`auto-start-${server.id}`} className="text-xs font-medium cursor-pointer" style={{ color: "var(--text-primary)" }}>
            Auto-start on launch
          </Label>
          <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
            Start this server automatically when the app opens
          </p>
        </div>
      </div>
    </div>
  );
}

// ── ChartStatTile ─────────────────────────────────────────────────────────────

function ChartStatTile({
  icon: Icon,
  label,
  value,
  unit,
  neonColor,
  timeframe,
  onTimeframeChange,
  children,
}: {
  icon: React.ElementType;
  label: string;
  value: string | number | null;
  unit?: string;
  neonColor: string;
  timeframe?: Timeframe;
  onTimeframeChange?: (t: Timeframe) => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="glass-card rounded-xl p-4 flex flex-col gap-3"
      style={{ borderColor: "var(--border)" }}
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Icon className="w-4 h-4 shrink-0" style={{ color: neonColor }} />
          <span
            className="text-xs font-medium uppercase tracking-wider"
            style={{ color: "var(--text-primary)" }}
          >
            {label}
          </span>
        </div>
        {timeframe && onTimeframeChange && (
          <TimeframeSelect value={timeframe} onChange={onTimeframeChange} />
        )}
      </div>

      {/* Current value */}
      <div className="text-2xl font-bold leading-none" style={{ color: "var(--text-primary)" }}>
        {value ?? <span style={{ color: "var(--text-muted)" }}>—</span>}
        {value != null && unit && (
          <span className="text-sm font-normal ml-1" style={{ color: "var(--text-muted)" }}>{unit}</span>
        )}
      </div>

      {/* Divider */}
      <div style={{ borderTop: "1px solid rgba(255,255,255,0.05)" }} />

      {/* Chart or panel */}
      {children}
    </div>
  );
}


// ── OverviewTab ───────────────────────────────────────────────────────────────

export function OverviewTab({ server }: Props) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const stats = useServerStats(server);
  const startTime = useAppStore((s) => s.serverStartTimes[server.id]);
  const isServerScanPending = useAppStore((s) => s.isServerScanPending);

  const [modCount, setModCount]     = useState<number | null>(null);
  const [lastBackup,  setLastBackup]  = useState<string | null>(null);
  const [nextRestart,   setNextRestart]   = useState<string | null>(null);
  const [backupEnabled, setBackupEnabled] = useState<boolean | null>(null);
  const [actionPending, setActionPending] = useState(false);
  const [players, setPlayers]       = useState<ArkPlayer[] | null>(null);
  const [playersLoading, setPlayersLoading] = useState(false);
  const [showUpdateConfirm, setShowUpdateConfirm] = useState(false);
  const [applyingUpdate, setApplyingUpdate] = useState(false);
  const [autoCheckEnabled, setAutoCheckEnabled] = useState(true);
  const [restartAfterUpdate, setRestartAfterUpdate] = useState(true);

  // Per-tile timeframe selectors
  const [playersTf, setPlayersTf] = useState<Timeframe>("Live");
  const [cpuTf,     setCpuTf]     = useState<Timeframe>("Live");
  const [memTf,     setMemTf]     = useState<Timeframe>("Live");

  const hasUpdateAvailable = server.update_available === 1;
  const isRunning     = server.status === "running";
  const isStarting    = server.status === "starting";
  const isTransitioning = ["starting", "stopping", "updating"].includes(server.status);
  const isStartFailed = server.status === "start-failed";
  const isLinux = typeof navigator !== "undefined" && !navigator.userAgent.includes("Windows");

  // Keep the uptime counter ticking while the server is active.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!isRunning && !isStarting) return;
    const id = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, [isRunning, isStarting]);

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
        setAutoCheckEnabled((autoHours ?? "0") !== "0");
      }
    })();
    return () => { cancelled = true; };
  }, [server.id, server.install_path]);

  // ── Action helpers ──────────────────────────────────────────────────────────

  const buildStartParams = async (): Promise<StartServerParams> => {
    const [config, mods] = await Promise.all([
      getServerConfig(server.id),
      getServerMods(server.id),
    ]);
    const launchArgs: Record<string, string> = config ? JSON.parse(config.launch_args_json) : {};
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
    try {
      await updateServerStatus(server.id, "starting", null);
      queryClient.invalidateQueries({ queryKey: ["servers"] });
      await warnIfFirewallMissing(server);
      const params = await buildStartParams();
      const pid = await tauriCmd.startServer(params);
      await updateServerStatus(server.id, "starting", pid);
    } catch (e) {
      const errMsg = typeof e === "string" ? e : String(e);
      await updateServerStatus(server.id, "start-failed", null);
      toast.error(`${server.name} failed to start — ${errMsg}`);
      await dispatchNotification({
        eventType:  NOTIFICATION_EVENTS.SERVER_START_FAILED,
        serverId:   server.id,
        serverName: server.name,
        title:      `${server.name} failed to start`,
        body:       errMsg,
        severity:   "error",
      });
    } finally {
      queryClient.invalidateQueries({ queryKey: ["servers"] });
      setActionPending(false);
    }
  };

  const handleStop = async () => {
    setActionPending(true);
    try {
      await updateServerStatus(server.id, "stopping", null);
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
      await updateServerStatus(server.id, "error", null);
    } finally {
      queryClient.invalidateQueries({ queryKey: ["servers"] });
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
      queryClient.invalidateQueries({ queryKey: ["servers"] });
      setActionPending(false);
    }
  };

  const handleRestart = async () => {
    setActionPending(true);
    try {
      await updateServerStatus(server.id, "stopping", null);
      queryClient.invalidateQueries({ queryKey: ["servers"] });
      const params = await buildStartParams();
      const pid = await tauriCmd.restartServer(params, true);
      await updateServerStatus(server.id, "running", pid);
    } catch (err) {
      toast.error(`Failed to restart ${server.name}`, { description: String(err) });
      await updateServerStatus(server.id, "error", null);
    } finally {
      queryClient.invalidateQueries({ queryKey: ["servers"] });
      setActionPending(false);
    }
  };

  const handleApplyUpdate = async () => {
    setShowUpdateConfirm(false);
    setApplyingUpdate(true);
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
      setApplyingUpdate(false);
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
      router.push("/");
      tauriCmd.updateServer(server.id, server.install_path, cacheDir, steamcmdPath)
        .then(() => updateServerStatus(server.id, "stopped", null))
        .catch(() => updateServerStatus(server.id, "install_failed", null))
        .finally(() => queryClient.invalidateQueries({ queryKey: ["servers"] }));
    } catch (err) {
      toast.error(`Failed to start reinstall for ${server.name}`, { description: String(err) });
    }
  };

  const refreshPlayers = useCallback(async () => {
    setPlayersLoading(true);
    try {
      const list = await tauriCmd.rconGetPlayers(server.id);
      setPlayers(list);
    } catch (err) {
      setPlayers([]);
      toast.error("Failed to fetch player list via RCON", { description: String(err) });
    } finally {
      setPlayersLoading(false);
    }
  }, [server.id]);

  // Fetch player list on mount/server-change if running.
  useEffect(() => {
    if (server.status === "running") refreshPlayers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server.id]);

  // The per-server event emits the players array directly as payload.
  useTauriEvent<ArkPlayer[]>(
    `rcon://players/${server.id}`,
    (list) => setPlayers(list)
  );

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-6">

      {/* ── Quick actions ── */}
      {/* Structured as two non-wrapping groups so the right-side buttons
          never shift position when the primary status button changes label. */}
      <div
        className="glass-card rounded-xl p-4 flex items-center gap-3 overflow-hidden"
        style={{ borderColor: "rgba(var(--neon-purple-rgb),0.15)" }}
      >
        <span className="text-sm font-medium shrink-0" style={{ color: "var(--text-primary)" }}>
          Actions
        </span>

        {/* Left group — status-dependent buttons */}
        <div className="flex items-center gap-2 flex-1 min-w-0">
          {isServerScanPending ? (
            <Button size="sm" disabled className="gap-1.5">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              Detecting...
            </Button>
          ) : isStartFailed ? (
            <>
              <Button
                size="sm" onClick={handleStart} disabled={actionPending} className="gap-1.5"
                style={{ background: "rgba(0,255,136,0.12)", borderColor: "rgba(0,255,136,0.4)", color: "var(--neon-green)" }}
              >
                <Play className="w-3.5 h-3.5" /> Retry Start
              </Button>
              <Button
                size="sm" variant="outline" onClick={handleReinstall} className="gap-1.5"
                style={{ color: "var(--neon-purple)", borderColor: "rgba(var(--neon-purple-rgb),0.3)" }}
              >
                <RotateCcw className="w-3.5 h-3.5" /> Reinstall
              </Button>
            </>
          ) : server.status === "stopping" ? (
            <Button
              size="sm" onClick={handleForceStop} className="gap-1.5"
              style={{ background: "rgba(255,100,0,0.12)", borderColor: "rgba(255,100,0,0.4)", color: "#ff6400" }}
            >
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Force Stop
            </Button>
          ) : server.status === "starting" ? (
            <Button
              size="sm" onClick={handleForceStop} className="gap-1.5"
              style={{ background: "rgba(255,200,0,0.12)", borderColor: "rgba(255,200,0,0.4)", color: "#ffc800" }}
            >
              <X className="w-3.5 h-3.5" /> Cancel Startup
            </Button>
          ) : isRunning ? (
            <Button
              size="sm" onClick={handleStop} disabled={actionPending} className="gap-1.5"
              style={{ background: "rgba(255,0,85,0.12)", borderColor: "rgba(255,0,85,0.4)", color: "var(--neon-red)" }}
            >
              <Square className="w-3.5 h-3.5" /> Stop
            </Button>
          ) : (
            <Button
              size="sm" onClick={handleStart} disabled={actionPending} className="gap-1.5"
              style={{ background: "rgba(0,255,136,0.12)", borderColor: "rgba(0,255,136,0.4)", color: "var(--neon-green)" }}
            >
              <Play className="w-3.5 h-3.5" /> Start
            </Button>
          )}

          {isRunning && !isServerScanPending && (
            <Button size="sm" variant="outline" className="btn-neon-purple gap-1.5" onClick={handleRestart} disabled={actionPending}>
              <RotateCcw className="w-3.5 h-3.5" /> Restart
            </Button>
          )}
        </div>

        {/* Right group — persistent buttons that never move */}
        <div className="flex items-center gap-2 shrink-0">
          {hasUpdateAvailable && (
            <Button
              size="sm"
              disabled={applyingUpdate || isTransitioning || isStarting || !autoCheckEnabled}
              onClick={() => autoCheckEnabled && setShowUpdateConfirm(true)}
              title={!autoCheckEnabled ? "Enable auto update checks in Settings to use this feature" : undefined}
              className="gap-1.5"
              style={{
                background: autoCheckEnabled ? "rgba(255,165,0,0.12)" : "rgba(255,165,0,0.04)",
                border: `1px solid ${autoCheckEnabled ? "rgba(255,165,0,0.4)" : "rgba(255,165,0,0.15)"}`,
                color: autoCheckEnabled ? "#ffa500" : "rgba(255,165,0,0.4)",
              }}
            >
              {applyingUpdate ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ArrowUp className="w-3.5 h-3.5" />}
              Apply Update
            </Button>
          )}

          <Button
            size="sm" variant="outline" disabled={isTransitioning}
            onClick={async () => {
              const backupDir = await getAppSetting("backup_dir");
              if (!backupDir) return;
              const mapPath = ARK_MAPS.find((m) => m.id === server.map_id)?.mapPath ?? "TheIsland_WP";
              tauriCmd.createServerBackup(server.id, server.name, server.install_path, mapPath, server.map_id, backupDir, "manual")
                .then(async (record: BackupRecord) => {
                  await insertBackup({
                    id: record.id, server_id: record.serverId, file_path: record.filePath,
                    file_size_bytes: record.fileSizeBytes, map_id: record.mapId,
                    triggered_by: "manual", created_at: record.createdAt,
                    backup_type: "server", tiers: "", player_eosid: null, player_name: null,
                  });
                  const keep = parseInt(await getAppSetting(`manual_backup_keep_${server.id}`) ?? "5", 10);
                  await pruneManualBackups(server.id, "server", isNaN(keep) ? 5 : keep);
                })
                .catch(() => null);
            }}
          >
            <Save className="w-3.5 h-3.5 mr-1.5" /> Backup Now
          </Button>
        </div>
      </div>

      {/* ── Chart tiles (2-column) ── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">

        {/* Uptime first — also surfaces map, mods, backup and schedule info */}
        <ChartStatTile
          icon={Clock}
          label={isStarting ? "Starting…" : "Uptime"}
          value={
            startTime != null
              ? formatUptime(startTime)
              : isRunning
              ? formatUptime(new Date(server.updated_at).getTime())
              : null
          }
          neonColor="var(--neon-purple)"
        >
          <ServerSummaryPanel
            server={server}
            startTime={startTime}
            modCount={modCount}
            lastBackup={lastBackup}
            nextRestart={nextRestart}
            backupEnabled={backupEnabled}
            onAutoStartChange={async (v) => {
              await setServerAutoStart(server.id, v);
              queryClient.invalidateQueries({ queryKey: ["servers"] });
            }}
          />
        </ChartStatTile>

        <ChartStatTile
          icon={Users}
          label="Players"
          value={stats.playersOnline != null ? `${stats.playersOnline} / ${stats.maxPlayers ?? server.max_players}` : null}
          neonColor="var(--neon-cyan)"
          timeframe={playersTf}
          onTimeframeChange={setPlayersTf}
        >
          <StatChart serverId={server.id} metric="players" timeframe={playersTf} />
        </ChartStatTile>

        <ChartStatTile
          icon={Cpu}
          label="CPU"
          value={stats.cpuPercent != null ? stats.cpuPercent.toFixed(1) : null}
          unit="%"
          neonColor="var(--neon-green)"
          timeframe={cpuTf}
          onTimeframeChange={setCpuTf}
        >
          <StatChart serverId={server.id} metric="cpu" timeframe={cpuTf} />
        </ChartStatTile>

        <ChartStatTile
          icon={MemoryStick}
          label="RAM"
          value={stats.memoryMb != null ? (stats.memoryMb / 1024).toFixed(2) : null}
          unit="GB"
          neonColor="var(--neon-purple)"
          timeframe={memTf}
          onTimeframeChange={setMemTf}
        >
          <StatChart serverId={server.id} metric="mem" timeframe={memTf} />
        </ChartStatTile>

      </div>

      {/* ── Network / install info ── */}
      <div className="glass-card rounded-xl p-4" style={{ borderColor: "rgba(var(--neon-purple-rgb),0.15)" }}>
        <h3 className="text-sm font-semibold mb-3" style={{ color: "var(--text-primary)" }}>Network</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
          {[
            { label: "Game Port",   value: server.port },
            { label: "Query Port",  value: server.query_port },
            { label: "RCON Port",   value: server.rcon_port },
            { label: "Max Players", value: server.max_players },
          ].map(({ label, value }) => (
            <div key={label}>
              <div style={{ color: "var(--text-muted)" }} className="text-xs mb-0.5">{label}</div>
              <div className="font-mono font-semibold" style={{ color: "var(--text-primary)" }}>{value}</div>
            </div>
          ))}
        </div>

        <div className="mt-4 pt-3 flex items-center gap-6 flex-wrap" style={{ borderTop: "1px solid rgba(255,255,255,0.05)" }}>
          <div className="min-w-0">
            <div className="text-xs mb-0.5" style={{ color: "var(--text-muted)" }}>Server UUID</div>
            <div className="font-mono text-xs" style={{ color: "var(--text-primary)", opacity: 0.7 }}>{server.id}</div>
          </div>
          <button
            className="flex items-center gap-1.5 ml-auto shrink-0 text-xs rounded-lg px-3 py-1.5 transition-all"
            style={{
              background: "rgba(var(--neon-purple-rgb),0.06)",
              border: "1px solid rgba(var(--neon-purple-rgb),0.2)",
              color: "var(--text-muted)",
            }}
            onClick={() => tauriCmd.openFolder(server.install_path).catch(() => null)}
            title="Open install folder"
          >
            <FolderOpen className="w-3.5 h-3.5 shrink-0" />
            Open Install Folder
          </button>
        </div>
      </div>

      {/* ── Player list ── */}
      <div className="glass-card rounded-xl p-4" style={{ borderColor: "rgba(var(--neon-purple-rgb),0.15)" }}>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>Online Players</h3>
          <Button size="sm" variant="ghost" onClick={refreshPlayers} disabled={!isRunning || playersLoading}>
            <RefreshCw className={`w-3.5 h-3.5 mr-1.5 ${playersLoading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
        {!isRunning ? (
          <p className="text-sm" style={{ color: "var(--text-muted)" }}>Server is not running.</p>
        ) : players === null ? (
          <p className="text-sm" style={{ color: "var(--text-muted)" }}>Click Refresh to fetch the player list via RCON.</p>
        ) : players.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--text-muted)" }}>No players online.</p>
        ) : (
          <div className="flex flex-col gap-1">
            {players.map((p) => (
              <div
                key={p.playerId}
                className="flex items-center justify-between text-sm px-3 py-2 rounded-lg"
                style={{ background: "rgba(var(--neon-purple-rgb),0.04)", border: "1px solid rgba(var(--neon-purple-rgb),0.1)" }}
              >
                <span style={{ color: "var(--text-primary)" }}>{p.name}</span>
                <span className="font-mono text-xs" style={{ color: "var(--text-muted)" }}>{p.playerId}</span>
              </div>
            ))}
          </div>
        )}
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
                id="ov-restart-toggle"
                checked={restartAfterUpdate}
                onCheckedChange={setRestartAfterUpdate}
              />
              <Label htmlFor="ov-restart-toggle" className="text-sm cursor-pointer" style={{ color: "var(--text-primary)" }}>
                Restart server after update
              </Label>
            </div>
          )}

          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setShowUpdateConfirm(false)}
              style={{ borderColor: "rgba(var(--neon-purple-rgb),0.3)", color: "var(--text-muted)" }}>
              Cancel
            </Button>
            <Button onClick={handleApplyUpdate} disabled={applyingUpdate}
              style={{ background: "rgba(255,165,0,0.15)", borderColor: "rgba(255,165,0,0.5)", color: "#ffa500" }}>
              <ArrowUp className="w-3.5 h-3.5 mr-1.5" /> Update
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </div>
  );
}
