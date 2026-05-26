"use client";

import { useState, useEffect } from "react";
import {
  Play, Square, RotateCcw, Users, Cpu, MemoryStick, Clock,
  Map, Package, HardDrive, Save, RefreshCw, ArrowUp, Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useServerStats } from "@/hooks/useServerStats";
import { tauriCmd, type StartServerParams, type ArkPlayer } from "@/lib/tauri-commands";
import {
  updateServerStatus, getServerConfig, getServerModCount, getServerMods,
  getLastBackupTime, getNextScheduledRestart, getAppSetting, insertBackup, setAppSetting,
} from "@/lib/db";
import type { BackupRecord } from "@/lib/tauri-commands";
import { toast } from "sonner";
import { ARK_MAPS } from "@/data/game-data";
import { useQueryClient } from "@tanstack/react-query";
import type { ServerRow } from "@/lib/db";

interface Props {
  server: ServerRow;
}

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
  const diffMins = Math.floor(Math.abs(Date.now() - d.getTime()) / 60_000);
  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  const h = Math.floor(diffMins / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function StatTile({
  icon: Icon, label, value, unit, neonColor,
}: {
  icon: React.ElementType;
  label: string;
  value: string | number | null;
  unit?: string;
  neonColor?: string;
}) {
  const color = neonColor ?? "var(--neon-purple)";
  return (
    <div
      className="glass-card rounded-xl p-4 flex flex-col gap-2"
      style={{ borderColor: `${color}30` }}
    >
      <div className="flex items-center gap-2">
        <Icon className="w-4 h-4 shrink-0" style={{ color }} />
        <span className="text-xs font-medium uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
          {label}
        </span>
      </div>
      <div className="text-2xl font-bold" style={{ color: "var(--text-primary)" }}>
        {value ?? <span style={{ color: "var(--text-muted)" }}>—</span>}
        {value != null && unit && (
          <span className="text-sm font-normal ml-1" style={{ color: "var(--text-muted)" }}>{unit}</span>
        )}
      </div>
    </div>
  );
}

export function OverviewTab({ server }: Props) {
  const queryClient = useQueryClient();
  const stats = useServerStats(server);

  const [modCount, setModCount] = useState<number | null>(null);
  const [lastBackup, setLastBackup] = useState<string | null>(null);
  const [nextRestart, setNextRestart] = useState<string | null>(null);
  const [actionPending, setActionPending] = useState(false);
  const [players, setPlayers] = useState<ArkPlayer[] | null>(null);
  const [playersLoading, setPlayersLoading] = useState(false);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [applyingUpdate, setApplyingUpdate] = useState(false);

  const isRunning = server.status === "running";
  const isTransitioning = ["starting", "stopping", "updating"].includes(server.status);
  const isLinux = typeof navigator !== "undefined" && !navigator.userAgent.includes("Windows");

  // Force a re-render every 30 s so the uptime counter visually advances.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!isRunning) return;
    const id = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, [isRunning]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [mc, lb, nr, cachedBuild, serverBuild] = await Promise.all([
        getServerModCount(server.id),
        getLastBackupTime(server.id),
        getNextScheduledRestart(server.id),
        getAppSetting("asa_cached_build_id"),
        tauriCmd.getInstalledBuildId(server.install_path).catch(() => null),
      ]);
      if (!cancelled) {
        setModCount(mc);
        setLastBackup(lb);
        setNextRestart(nr);
        if (cachedBuild && serverBuild && cachedBuild !== "0" && serverBuild !== "0") {
          setUpdateAvailable(parseInt(cachedBuild) > parseInt(serverBuild));
        }
      }
    })();
    return () => { cancelled = true; };
  }, [server.id, server.install_path]);

  const buildStartParams = async (): Promise<StartServerParams> => {
    const [config, mods] = await Promise.all([
      getServerConfig(server.id),
      getServerMods(server.id),
    ]);
    const launchArgs: Record<string, string> = config ? JSON.parse(config.launch_args_json) : {};
    const extraArgs = Object.entries(launchArgs)
      .filter(([, v]) => v === "true" || v === "1")
      .map(([k]) => `-${k}`);
    const map = ARK_MAPS.find((m) => m.id === server.map_id);
    const enabledModIds = mods.filter((m) => m.enabled === 1).map((m) => m.mod_id);
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
      const params = await buildStartParams();
      const pid = await tauriCmd.startServer(params);
      // Keep status "starting" — Rust backend will emit server://status/{id}
      // with "running" once the RCON port responds (server fully loaded).
      await updateServerStatus(server.id, "starting", pid);
    } catch (e) {
      await updateServerStatus(server.id, "error", null);
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
      await tauriCmd.stopServer(server.id, true);
      await updateServerStatus(server.id, "stopped", null);
    } catch {
      await updateServerStatus(server.id, "error", null);
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
    } catch {
      await updateServerStatus(server.id, "error", null);
    } finally {
      queryClient.invalidateQueries({ queryKey: ["servers"] });
      setActionPending(false);
    }
  };

  const handleApplyUpdate = async () => {
    setApplyingUpdate(true);
    try {
      const cacheBase = await getAppSetting("base_dir");
      if (!cacheBase) { toast.error("Base directory not configured."); return; }
      const sep = cacheBase.includes("\\") ? "\\" : "/";
      const cacheDir = `${cacheBase.replace(/[/\\]$/, "")}${sep}lokiasam${sep}cache${sep}asa-server`;
      await tauriCmd.applyCacheToServer(server.id, server.install_path, cacheDir);
      // Update the cached build ID so the badge refreshes.
      const cachedBuild = await getAppSetting("asa_cached_build_id");
      if (cachedBuild) await setAppSetting(`asa_installed_build_${server.id}`, cachedBuild);
      setUpdateAvailable(false);
      toast.success("Update applied. Restart the server to use the new version.");
    } catch (e) {
      toast.error(`Apply update failed: ${e}`);
    } finally {
      setApplyingUpdate(false);
    }
  };

  const refreshPlayers = async () => {
    setPlayersLoading(true);
    try {
      await tauriCmd.rconConnect(server.id, "127.0.0.1", server.rcon_port, server.rcon_password);
      const list = await tauriCmd.rconGetPlayers(server.id);
      setPlayers(list);
    } catch {
      setPlayers([]);
    } finally {
      setPlayersLoading(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      {/* ── Quick actions ── */}
      <div
        className="glass-card rounded-xl p-4 flex items-center gap-3 flex-wrap"
        style={{ borderColor: "rgba(191,0,255,0.15)" }}
      >
        <span className="text-sm font-medium mr-2" style={{ color: "var(--text-muted)" }}>
          Actions
        </span>
        {!isRunning ? (
          <Button
            size="sm"
            className="btn-neon-green"
            onClick={handleStart}
            disabled={actionPending || isTransitioning}
          >
            <Play className="w-3.5 h-3.5 mr-1.5" />
            Start
          </Button>
        ) : (
          <Button
            size="sm"
            className="btn-neon-red"
            onClick={handleStop}
            disabled={actionPending || isTransitioning}
          >
            <Square className="w-3.5 h-3.5 mr-1.5" />
            Stop
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          className="btn-neon-purple"
          onClick={handleRestart}
          disabled={actionPending || isTransitioning || !isRunning}
        >
          <RotateCcw className="w-3.5 h-3.5 mr-1.5" />
          Restart
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={async () => {
            const backupDir = await getAppSetting("backup_dir");
            if (!backupDir) return;
            tauriCmd.createBackup(server.id, server.name, server.install_path, backupDir, server.map_id, "manual")
              .then(async (record: BackupRecord) => {
                await insertBackup({ id: record.id, server_id: record.serverId, file_path: record.filePath, file_size_bytes: record.fileSizeBytes, map_id: record.mapId, triggered_by: record.triggeredBy, created_at: record.createdAt });
              })
              .catch(() => null);
          }}
          disabled={isTransitioning}
        >
          <Save className="w-3.5 h-3.5 mr-1.5" />
          Backup Now
        </Button>
        {updateAvailable && (
          <Button
            size="sm"
            disabled={applyingUpdate || isTransitioning}
            onClick={handleApplyUpdate}
            className="gap-1.5"
            style={{
              background: "rgba(255,165,0,0.12)",
              border: "1px solid rgba(255,165,0,0.4)",
              color: "#ffa500",
            }}
          >
            {applyingUpdate
              ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
              : <ArrowUp className="w-3.5 h-3.5" />}
            Apply Update
          </Button>
        )}
      </div>

      {/* ── Stats grid ── */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
        <StatTile
          icon={Users}
          label="Players"
          value={stats.playersOnline != null ? `${stats.playersOnline} / ${stats.maxPlayers ?? server.max_players}` : null}
          neonColor="var(--neon-cyan)"
        />
        <StatTile
          icon={Cpu}
          label="CPU"
          value={stats.cpuPercent != null ? stats.cpuPercent.toFixed(1) : null}
          unit="%"
          neonColor="var(--neon-purple)"
        />
        <StatTile
          icon={MemoryStick}
          label="RAM"
          value={stats.memoryMb != null ? Math.round(stats.memoryMb) : null}
          unit="MB"
          neonColor="var(--neon-purple)"
        />
        <StatTile
          icon={Clock}
          label="Uptime"
          value={isRunning ? formatUptime(server.updated_at) : null}
          neonColor="var(--neon-green)"
        />
        <StatTile
          icon={Map}
          label="Map"
          value={ARK_MAPS.find((m) => m.id === server.map_id)?.displayName ?? server.map_id}
        />
        <StatTile
          icon={Package}
          label="Mods"
          value={modCount ?? 0}
        />
        <StatTile
          icon={HardDrive}
          label="Last Backup"
          value={formatRelativeTime(lastBackup)}
        />
        <StatTile
          icon={Clock}
          label="Next Restart"
          value={nextRestart ?? "Not scheduled"}
        />
      </div>

      {/* ── Network info ── */}
      <div
        className="glass-card rounded-xl p-4"
        style={{ borderColor: "rgba(191,0,255,0.15)" }}
      >
        <h3 className="text-sm font-semibold mb-3" style={{ color: "var(--text-muted)" }}>
          Network
        </h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
          {[
            { label: "Game Port", value: server.port },
            { label: "Query Port", value: server.query_port },
            { label: "RCON Port", value: server.rcon_port },
            { label: "Max Players", value: server.max_players },
          ].map(({ label, value }) => (
            <div key={label}>
              <div style={{ color: "var(--text-muted)" }} className="text-xs mb-0.5">{label}</div>
              <div
                className="font-mono font-semibold"
                style={{ color: "var(--text-primary)" }}
              >
                {value}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Player list ── */}
      <div
        className="glass-card rounded-xl p-4"
        style={{ borderColor: "rgba(0,255,255,0.15)" }}
      >
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold" style={{ color: "var(--text-muted)" }}>
            Online Players
          </h3>
          <Button
            size="sm"
            variant="ghost"
            onClick={refreshPlayers}
            disabled={!isRunning || playersLoading}
          >
            <RefreshCw className={`w-3.5 h-3.5 mr-1.5 ${playersLoading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
        {!isRunning ? (
          <p className="text-sm" style={{ color: "var(--text-muted)" }}>
            Server is not running.
          </p>
        ) : players === null ? (
          <p className="text-sm" style={{ color: "var(--text-muted)" }}>
            Click Refresh to fetch the player list via RCON.
          </p>
        ) : players.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--text-muted)" }}>
            No players online.
          </p>
        ) : (
          <div className="flex flex-col gap-1">
            {players.map((p) => (
              <div
                key={p.steamId}
                className="flex items-center justify-between text-sm px-3 py-2 rounded-lg"
                style={{ background: "rgba(0,255,255,0.04)", border: "1px solid rgba(0,255,255,0.1)" }}
              >
                <span style={{ color: "var(--text-primary)" }}>{p.name}</span>
                <span className="font-mono text-xs" style={{ color: "var(--text-muted)" }}>
                  {p.steamId}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
