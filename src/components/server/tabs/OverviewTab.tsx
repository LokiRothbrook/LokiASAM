"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  Play, Square, RotateCcw, Users, Cpu, MemoryStick, Clock,
  Save, RefreshCw, ArrowUp, Loader2, X, BarChart2, FolderOpen,
  Settings2, Terminal, Skull, ChevronDown, ChevronRight, Sparkles, Ban,
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
import { tauriCmd, type ArkPlayer } from "@/lib/tauri-commands";
import { useAppStore } from "@/store/useAppStore";
import {
  updateServerStatus, getServerConfig, getServerModCount,
  getLastBackupTime, getNextScheduledRestart, getHasBackupEnabled, getAppSetting, insertBackup,
  pruneManualBackups, setServerAutoStart,
} from "@/lib/db";
import { buildLaunchCommandPreview, buildStartParams, restartServerGracefully, stopServerGracefully } from "@/lib/server-utils";
import { applyUpdateToServer } from "@/lib/update-utils";
import { reinstallServer } from "@/lib/server-actions";
import { warnIfFirewallMissing } from "@/lib/firewall-utils";
import type { BackupRecord } from "@/lib/tauri-commands";
import type { ServerRow } from "@/lib/db";
import { toast } from "sonner";
import { ARK_EVENTS, NOTIFICATION_EVENTS, getSaveFolder } from "@/data/game-data";
import { useAllMaps } from "@/hooks/useAllMaps";
import { ensureMapsCacheLoaded, findMapById } from "@/lib/maps";
import { dispatchNotification } from "@/lib/notifications";
import { useQueryClient } from "@tanstack/react-query";
import { useTauriEvent } from "@/hooks/useTauriEvent";
import { useOnMount } from "@/hooks/useOnMount";

interface Props {
  server: ServerRow;
  /** Switch the parent's active tab to Config; optionally pass a section id to scroll to. */
  onNavigateToConfig?: (anchor?: string) => void;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const TIMEFRAMES: Timeframe[] = ["Live", "1H", "6H", "24H", "7D", "30D", "3M", "6M", "1Y"];

const METRIC_CONFIG = {
  cpu:     { color: "var(--neon-green)",  avgKey: "cpu",     maxKey: "cpuMax"     },
  mem:     { color: "var(--neon-purple)", avgKey: "mem",     maxKey: "memMax"     },
  players: { color: "var(--neon-cyan)",   avgKey: "players", maxKey: "playersMax" },
} as const;

// ── Helpers ───────────────────────────────────────────────────────────────────

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
        background: "var(--popover)",
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

  const allMaps = useAllMaps();
  const mapDisplay = allMaps.find((m) => m.id === server.map_id)?.displayName ?? server.map_id;

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


// ── ActiveConfigPanel ────────────────────────────────────────────────────────

type ActiveConfig = {
  gameUserSettings: Record<string, Record<string, string>>;
  gameIni: Record<string, Record<string, string>>;
  launchArgs: Record<string, string>;
};

function gusVal(cfg: ActiveConfig, key: string): string {
  return cfg.gameUserSettings?.["ServerSettings"]?.[key] ?? "";
}

function gameVal(cfg: ActiveConfig, key: string): string {
  return cfg.gameIni?.["/script/shootergame.shootergamemode"]?.[key] ?? "";
}

function fmtMult(raw: string, def = "1.0"): string {
  const n = parseFloat(raw || def);
  return isNaN(n) ? def : `${n}×`;
}

function ActiveConfigPanel({
  config,
  modCount,
  launchCommand,
  onNavigateToConfig,
}: {
  config: ActiveConfig | null;
  modCount: number | null;
  launchCommand: string;
  onNavigateToConfig: () => void;
}) {
  const [cliExpanded, setCliExpanded] = useState(false);
  if (!config) return null;

  const pvp = gusVal(config, "ServerPVE") !== "True";
  const orp = gusVal(config, "PreventOfflinePvP") === "True";
  const orpGrace = gusVal(config, "PreventOfflinePvPInterval");
  const battleEye = config.launchArgs?.["NoBattlEye"] !== "true";
  const harvest   = fmtMult(gusVal(config, "HarvestAmountMultiplier"));
  const xp        = fmtMult(gusVal(config, "XPMultiplier"));
  const taming    = fmtMult(gusVal(config, "TamingSpeedMultiplier"));
  const matureFull = gameVal(config, "BabyMatureSpeedMultiplier");
  const mature    = fmtMult(matureFull);

  const statItems = [
    { label: "Mode",      value: pvp ? "PvP" : "PvE",      accent: pvp ? "var(--neon-purple)" : "var(--neon-green)" },
    { label: "ORP",       value: orp ? `On${orpGrace ? ` (${parseInt(orpGrace) / 60 | 0}m grace)` : ""}` : "Off", accent: orp ? "var(--neon-cyan)" : "var(--text-muted)" },
    { label: "Harvest",   value: harvest,   accent: "var(--text-primary)" },
    { label: "XP",        value: xp,        accent: "var(--text-primary)" },
    { label: "Taming",    value: taming,    accent: "var(--text-primary)" },
    { label: "Baby Mature", value: mature,  accent: "var(--text-primary)" },
    { label: "Mods",      value: modCount != null ? String(modCount) : "—", accent: "var(--text-primary)" },
    { label: "BattlEye",  value: battleEye ? "On" : "Off",  accent: battleEye ? "var(--neon-green)" : "var(--text-muted)" },
  ];

  return (
    <div className="glass-card rounded-xl p-4 space-y-4" style={{ borderColor: "rgba(var(--neon-purple-rgb),0.15)" }}>
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-2 text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
          <Settings2 className="w-3.5 h-3.5" style={{ color: "var(--neon-purple)" }} />
          Active Configuration
        </span>
        <button onClick={onNavigateToConfig} className="text-xs px-3 py-1 rounded-md"
          style={{ background: "rgba(var(--neon-purple-rgb),0.08)", color: "var(--neon-purple)", border: "1px solid rgba(var(--neon-purple-rgb),0.2)" }}>
          Configure →
        </button>
      </div>

      {/* Key stats grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {statItems.map(({ label, value, accent }) => (
          <div key={label} className="rounded-lg px-3 py-2" style={{ background: "rgba(var(--neon-purple-rgb),0.04)", border: "1px solid rgba(var(--neon-purple-rgb),0.1)" }}>
            <div className="text-xs mb-0.5" style={{ color: "var(--text-muted)" }}>{label}</div>
            <div className="text-sm font-semibold" style={{ color: accent }}>{value}</div>
          </div>
        ))}
      </div>

      {/* Launch command — collapsed by default */}
      {launchCommand && (
        <div>
          <button
            type="button"
            onClick={() => setCliExpanded((v) => !v)}
            className="flex items-center gap-1.5 w-full text-left"
          >
            {cliExpanded
              ? <ChevronDown  className="w-3 h-3 shrink-0" style={{ color: "var(--text-muted)" }} />
              : <ChevronRight className="w-3 h-3 shrink-0" style={{ color: "var(--text-muted)" }} />}
            <Terminal className="w-3 h-3 shrink-0" style={{ color: "var(--text-muted)" }} />
            <span className="text-xs" style={{ color: "var(--text-muted)" }}>Launch Command</span>
          </button>
          {cliExpanded && (
            <div className="mt-1.5 rounded-lg px-3 py-2 overflow-x-auto" style={{ background: "rgba(0,0,0,0.3)", border: "1px solid rgba(var(--neon-purple-rgb),0.1)" }}>
              <code className="text-xs font-mono whitespace-pre-wrap break-all" style={{ color: "var(--neon-cyan)" }}>{launchCommand}</code>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── OverviewTab ───────────────────────────────────────────────────────────────

export function OverviewTab({ server, onNavigateToConfig }: Props) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const stats = useServerStats(server);
  const startTime = useAppStore((s) => s.serverStartTimes[server.id]);
  const isServerScanPending = useAppStore((s) => s.isServerScanPending);
  const countdown = useAppStore((s) => s.countdowns[server.id] ?? null);
  const noRetry = useAppStore((s) => !!s.noRetryServerIds[server.id]);
  const setNoRetryServer = useAppStore((s) => s.setNoRetryServer);
  const clearNoRetryServer = useAppStore((s) => s.clearNoRetryServer);
  const enqueueStartup = useAppStore((s) => s.enqueueStartup);
  const removeFromStartupQueue = useAppStore((s) => s.removeFromStartupQueue);

  const [modCount, setModCount]     = useState<number | null>(null);
  const [activeConfig, setActiveConfig] = useState<ActiveConfig | null>(null);
  const [lastBackup,  setLastBackup]  = useState<string | null>(null);

  // Refresh the Last Backup tile when a scheduled (hourly) backup finishes —
  // without this it stays stale (showing the pre-backup time) until this tab
  // remounts, since it's otherwise only fetched once on mount below.
  useTauriEvent(`backup://completed/${server.id}`, () => {
    getLastBackupTime(server.id).then(setLastBackup).catch(() => {});
  });
  const [nextRestart,   setNextRestart]   = useState<string | null>(null);
  const [backupEnabled, setBackupEnabled] = useState<boolean | null>(null);
  const [actionPending, setActionPending] = useState(false);
  const [players, setPlayers]       = useState<ArkPlayer[] | null>(null);
  const [playersLoading, setPlayersLoading] = useState(false);
  const [showUpdateConfirm, setShowUpdateConfirm] = useState(false);
  const [applyingUpdate, setApplyingUpdate] = useState(false);
  const [autoCheckEnabled, setAutoCheckEnabled] = useState(true);
  const [restartAfterUpdate, setRestartAfterUpdate] = useState(true);
  const [launchCommand, setLaunchCommand] = useState("");
  const [wipingDinos, setWipingDinos] = useState(false);
  const activeEventId = server.active_event ?? null;

  // Per-tile timeframe selectors
  const [playersTf, setPlayersTf] = useState<Timeframe>("Live");
  const [cpuTf,     setCpuTf]     = useState<Timeframe>("Live");
  const [memTf,     setMemTf]     = useState<Timeframe>("Live");

  const hasUpdateAvailable = server.update_available === 1;
  const isRunning     = server.status === "running";
  const isStarting    = server.status === "starting";
  const isTransitioning = ["starting", "stopping", "updating", "update_queued"].includes(server.status);
  const isStartFailed = server.status === "start-failed";
  const isUpdateQueued  = server.status === "update_queued";
  const isStartupQueued = server.status === "startup_queued";

  // Keep the uptime counter ticking while the server is active.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!isRunning && !isStarting) return;
    const id = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, [isRunning, isStarting]);

  // server is read via a ref inside the effect below so unrelated re-renders
  // (e.g. status polling) don't force server's full identity into that
  // effect's deps — only an actual id/install_path change should refetch.
  const serverRef = useRef(server);
  useEffect(() => {
    serverRef.current = server;
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [mc, lb, nr, be, autoHours, cfgRow] = await Promise.all([
        getServerModCount(server.id),
        getLastBackupTime(server.id),
        getNextScheduledRestart(server.id),
        getHasBackupEnabled(server.id),
        getAppSetting("asa_auto_check_hours"),
        getServerConfig(server.id),
      ]);
      if (!cancelled) {
        setModCount(mc);
        if (cfgRow) {
          const launchArgs = JSON.parse(cfgRow.launch_args_json || "{}");
          setActiveConfig({
            gameUserSettings: JSON.parse(cfgRow.game_user_settings_json || "{}"),
            gameIni: JSON.parse(cfgRow.game_ini_json || "{}"),
            launchArgs,
          });
          // Build launch command preview (async, non-blocking)
          buildLaunchCommandPreview(serverRef.current, launchArgs).then(setLaunchCommand).catch(() => {});
        }
        setLastBackup(lb);
        setNextRestart(nr);
        setBackupEnabled(be);
        setAutoCheckEnabled((autoHours ?? "disabled") !== "disabled");
      }
    })();
    return () => { cancelled = true; };
  }, [server.id, server.install_path]);

  const navigateToConfig = (anchor?: string) => {
    if (onNavigateToConfig) {
      onNavigateToConfig(anchor);
      return;
    }
    const url = new URL(window.location.href);
    url.searchParams.set("tab", "config");
    router.push(url.pathname + url.search);
    if (anchor) {
      setTimeout(() => document.getElementById(anchor)?.scrollIntoView({ behavior: "smooth", block: "start" }), 300);
    }
  };

  // ── Action helpers ──────────────────────────────────────────────────────────

  const handleStart = async () => {
    setActionPending(true);
    clearNoRetryServer(server.id);
    try {
      await updateServerStatus(server.id, "starting", null);
      queryClient.invalidateQueries({ queryKey: ["servers"] });

      // Ensure both save symlinks/junctions are in place before launching —
      // self-heals a server whose links were lost (e.g. after moving
      // base_dir), same repair step the dashboard card's Start runs.
      const baseDir = await getAppSetting("base_dir").catch(() => null);
      if (baseDir) {
        await ensureMapsCacheLoaded().catch(() => {});
        const mapPath = findMapById(server.map_id)?.mapPath ?? "TheIsland_WP";
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
      await updateServerStatus(server.id, "starting", pid);
    } catch (e) {
      const raw = typeof e === "string" ? e : String(e);
      const isExeMissing = raw.startsWith("exe_missing:");
      const errMsg = isExeMissing ? raw.slice("exe_missing: ".length) : raw;
      if (isExeMissing) setNoRetryServer(server.id);

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

  // Default entry point for the manual "Start" button — hands off to the
  // staggered startup queue instead of launching directly, matching the
  // dashboard card's Start button, so starting from this tab can't pile a
  // second simultaneous boot on top of whatever's currently starting.
  const handleQueueStart = async () => {
    setActionPending(true);
    clearNoRetryServer(server.id);
    try {
      await updateServerStatus(server.id, "startup_queued", null);
      queryClient.invalidateQueries({ queryKey: ["servers"] });
      enqueueStartup([server.id]);
    } catch (err) {
      toast.error(`Failed to queue ${server.name} to start`, { description: String(err) });
    } finally {
      setActionPending(false);
    }
  };

  const handleStop = async () => {
    setActionPending(true);
    try {
      await stopServerGracefully(server, {
        onInvalidate: () => queryClient.invalidateQueries({ queryKey: ["servers"] }),
      });
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
    // Only the plain (non-warn) path is a quick stop+handoff worth a pending
    // spinner — the warn path runs a countdown that can last minutes.
    const isWarnRestart = !!server.restart_warn_players;
    if (!isWarnRestart) setActionPending(true);
    try {
      await restartServerGracefully(server, {
        onInvalidate: () => queryClient.invalidateQueries({ queryKey: ["servers"] }),
      });
    } catch (err) {
      toast.error(`Failed to restart ${server.name}`, { description: String(err) });
    } finally {
      if (!isWarnRestart) setActionPending(false);
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

      // Show a visible transition immediately — otherwise the card sits on
      // "running" with no feedback until the warning countdown finishes.
      // Rust reverts this back to "running" if the countdown gets cancelled.
      await updateServerStatus(server.id, "stopping", server.pid);
      queryClient.invalidateQueries({ queryKey: ["servers"] });

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
      setApplyingUpdate(false);
      queryClient.invalidateQueries({ queryKey: ["servers"] });
    }
  };

  const handleReinstall = async () => {
    queryClient.invalidateQueries({ queryKey: ["servers"] });
    router.push("/");
    try {
      await reinstallServer(server);
    } catch (err) {
      toast.error(`Reinstall failed for ${server.name}`, { description: String(err) });
    } finally {
      queryClient.invalidateQueries({ queryKey: ["servers"] });
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
  const syncPlayersIfRunning = useCallback(() => {
    if (server.status === "running") refreshPlayers();
  }, [server.status, refreshPlayers]);
  useOnMount(syncPlayersIfRunning);

  // The per-server event emits the players array directly as payload.
  useTauriEvent<ArkPlayer[]>(
    `rcon://players/${server.id}`,
    (list) => setPlayers(list)
  );

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-6 pr-6">

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
          {countdown ? (
            <>
              <span className="text-xs font-medium" style={{ color: "#ff8c00" }}>
                {countdown.action === "restart"
                  ? `Restarting in ${formatCountdown(countdown.remainingSecs)}`
                  : `Updating in ${formatCountdown(countdown.remainingSecs)}`}
              </span>
              <Button
                size="sm"
                onClick={() => tauriCmd.proceedNow(server.id).catch(() => {})}
                className="gap-1.5"
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
          ) : isServerScanPending ? (
            <Button size="sm" disabled className="gap-1.5">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              Detecting...
            </Button>
          ) : isUpdateQueued ? (
            <>
              <span className="text-xs flex items-center gap-1.5" style={{ color: "#ffa500" }}>
                <Loader2 className="w-3 h-3 animate-spin" /> Update queued
              </span>
              <Button
                size="sm" variant="outline"
                onClick={async () => {
                  await updateServerStatus(server.id, "stopped", null);
                  queryClient.invalidateQueries({ queryKey: ["servers"] });
                }}
                className="gap-1.5"
                style={{ color: "var(--text-muted)", borderColor: "rgba(var(--neon-purple-rgb),0.2)" }}
              >
                <Ban className="w-3.5 h-3.5" /> Cancel
              </Button>
            </>
          ) : isStartupQueued ? (
            <>
              <span className="text-xs flex items-center gap-1.5" style={{ color: "var(--neon-cyan)" }}>
                <Loader2 className="w-3 h-3 animate-spin" /> Startup queued
              </span>
              <Button
                size="sm" disabled={actionPending}
                onClick={() => { removeFromStartupQueue(server.id); handleStart(); }}
                className="gap-1.5"
                title="Start immediately, skipping the wait for its turn"
                style={{ background: "rgba(0,255,136,0.12)", borderColor: "rgba(0,255,136,0.4)", color: "var(--neon-green)" }}
              >
                <Play className="w-3.5 h-3.5" /> Skip Queue
              </Button>
              <Button
                size="sm" variant="outline"
                onClick={async () => {
                  removeFromStartupQueue(server.id);
                  await updateServerStatus(server.id, "stopped", null);
                  queryClient.invalidateQueries({ queryKey: ["servers"] });
                }}
                className="gap-1.5"
                style={{ color: "var(--text-muted)", borderColor: "rgba(var(--neon-purple-rgb),0.2)" }}
              >
                <Ban className="w-3.5 h-3.5" /> Cancel
              </Button>
            </>
          ) : isStartFailed ? (
            <>
              {!noRetry && (
                <Button
                  size="sm" onClick={handleStart} disabled={actionPending} className="gap-1.5"
                  style={{ background: "rgba(0,255,136,0.12)", borderColor: "rgba(0,255,136,0.4)", color: "var(--neon-green)" }}
                >
                  <Play className="w-3.5 h-3.5" /> Retry Start
                </Button>
              )}
              <Button
                size="sm" variant="outline" onClick={handleReinstall} className="gap-1.5"
                style={{ color: "var(--neon-purple)", borderColor: "rgba(var(--neon-purple-rgb),0.3)" }}
              >
                <RotateCcw className="w-3.5 h-3.5" /> Reinstall
              </Button>
            </>
          ) : server.status === "stopping" ? (
            <Button
              size="sm" onClick={handleForceStop} disabled={actionPending} className="gap-1.5"
              style={{ background: "rgba(255,100,0,0.12)", borderColor: "rgba(255,100,0,0.4)", color: "#ff6400" }}
            >
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Force Stop
            </Button>
          ) : server.status === "starting" ? (
            <Button
              size="sm" onClick={handleForceStop} disabled={actionPending} className="gap-1.5"
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
              size="sm" onClick={handleQueueStart} disabled={actionPending} className="gap-1.5"
              style={{ background: "rgba(0,255,136,0.12)", borderColor: "rgba(0,255,136,0.4)", color: "var(--neon-green)" }}
            >
              <Play className="w-3.5 h-3.5" /> Start
            </Button>
          )}

          {isRunning && !isServerScanPending && !countdown && (
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
              const [backupDir, baseDir] = await Promise.all([getAppSetting("backup_dir"), getAppSetting("base_dir")]);
              if (!backupDir) return;
              await ensureMapsCacheLoaded().catch(() => {});
              const mapDef = findMapById(server.map_id);
              const mapPath = mapDef?.mapPath ?? "TheIsland_WP";
              const saveFolder = mapDef ? getSaveFolder(mapDef) : mapPath;
              tauriCmd.createServerBackup(server.id, server.name, server.install_path, mapPath, saveFolder, server.map_id, backupDir, "manual", "", baseDir ?? "")
                .then(async (record: BackupRecord) => {
                  await insertBackup({
                    id: record.id, server_id: record.serverId, file_path: record.filePath,
                    file_size_bytes: record.fileSizeBytes, map_id: record.mapId,
                    triggered_by: "manual", created_at: record.createdAt,
                    backup_type: "server", tiers: "", player_eosid: null, player_name: null,
                  });
                  const keep = parseInt(await getAppSetting(`manual_backup_keep_${server.id}`) ?? "5", 10);
                  await pruneManualBackups(server.id, "server", isNaN(keep) ? 5 : keep);
                  setLastBackup(record.createdAt);
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

      {/* ── Active Event (read-only — edit in Settings) ── */}
      <div
        className="glass-card rounded-xl p-4"
        style={{ border: "1px solid rgba(var(--neon-purple-rgb),0.15)" }}
      >
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-2 min-w-0">
            <Sparkles className="w-4 h-4 shrink-0" style={{ color: "var(--neon-purple)" }} />
            <div>
              <p className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>Active Event</p>
              <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
                {activeEventId
                  ? (ARK_EVENTS.find((e) => e.id === activeEventId)?.displayName ?? activeEventId)
                  : "No event active"}
              </p>
            </div>
          </div>
          <button onClick={() => navigateToConfig("settings-active-event")} className="text-xs px-3 py-1 rounded-md shrink-0"
            style={{ background: "rgba(var(--neon-purple-rgb),0.08)", color: "var(--neon-purple)", border: "1px solid rgba(var(--neon-purple-rgb),0.2)" }}>
            {activeEventId ? "Change →" : "Configure →"}
          </button>
        </div>
        {activeEventId && (() => {
          const evt = ARK_EVENTS.find((e) => e.id === activeEventId);
          return evt ? (
            <p className="text-xs mt-2 pl-6" style={{ color: "var(--text-muted)" }}>
              {evt.description} <span className="font-mono ml-1" style={{ color: "var(--text-subtle)" }}>Mod: {evt.modId}</span>
            </p>
          ) : null;
        })()}
      </div>

      {/* ── Active Configuration panel ── */}
      <ActiveConfigPanel
        config={activeConfig}
        modCount={modCount}
        launchCommand={launchCommand}
        onNavigateToConfig={() => navigateToConfig()}
      />

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

        <div className="mt-4 pt-3 flex items-center gap-3 flex-wrap" style={{ borderTop: "1px solid rgba(255,255,255,0.05)" }}>
          <button
            className="flex items-center gap-1.5 shrink-0 text-xs rounded-lg px-3 py-1.5 transition-all"
            style={{ background: "rgba(var(--neon-purple-rgb),0.06)", border: "1px solid rgba(var(--neon-purple-rgb),0.2)", color: "var(--text-muted)" }}
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

      {/* ── Wild Dino Wipe ── */}
      {isRunning && (
        <div className="glass-card rounded-xl p-4 space-y-3" style={{ border: "1px solid rgba(var(--neon-cyan-rgb, 0,255,255),0.15)" }}>
          <div className="flex items-center gap-2">
            <Skull className="w-4 h-4" style={{ color: "var(--neon-cyan)" }} />
            <h3 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>Wild Dino Wipe</h3>
          </div>
          <p className="text-xs" style={{ color: "var(--text-muted)" }}>
            Broadcasts a warning in chat then destroys all wild dinos. Expect lag for a few seconds.
          </p>
          <button
            onClick={async () => {
              setWipingDinos(true);
              try {
                await tauriCmd.rconSend(server.id, "ServerChat Wild dinos are being wiped — expect some lag!");
                await tauriCmd.rconSend(server.id, "destroywilddinos");
                toast.success("Wild dinos wiped");
              } catch (e) { toast.error(`Wipe failed: ${e}`); }
              finally { setWipingDinos(false); }
            }}
            disabled={wipingDinos}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg"
            style={{ background: "rgba(0,255,255,0.08)", border: "1px solid rgba(0,255,255,0.3)", color: "var(--neon-cyan)" }}
          >
            {wipingDinos ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Skull className="w-3.5 h-3.5" />}
            Wipe Wild Dinos
          </button>
        </div>
      )}

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
