"use client";

import { useState, useCallback, useEffect } from "react";
import {
  Archive, Plus, Trash2, RotateCcw, HardDrive, User, FileText,
  AlertCircle, Loader2, RefreshCw, CalendarClock,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  getServerBackupsByType, insertBackup, deleteBackupRecord,
  pruneManualBackups, getAppSetting, setAppSetting, getKnownPlayers,
  type BackupRow,
} from "@/lib/db";
import { tauriCmd } from "@/lib/tauri-commands";
import { useTauriEvent } from "@/hooks/useTauriEvent";
import { ARK_MAPS } from "@/data/game-data";
import type { ServerRow } from "@/lib/db";
import type { BackupRecord } from "@/lib/tauri-commands";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatHumanDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const datePart = d.toLocaleDateString(undefined, {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });
  const timePart = d.toLocaleTimeString(undefined, {
    hour: "numeric", minute: "2-digit", second: "2-digit",
  });
  return `${datePart} ${timePart}`;
}

function platform(): string {
  return typeof navigator !== "undefined" && !navigator.userAgent.includes("Windows")
    ? "LinuxServer"
    : "WindowsServer";
}

// ---------------------------------------------------------------------------
// Tier tags
// ---------------------------------------------------------------------------

const TIER_COLORS: Record<string, string> = {
  H: "#00ffff",
  D: "#bf00ff",
  W: "#00ff88",
  M: "#ffa500",
};
const TIER_NAMES: Record<string, string> = {
  H: "Hourly",
  D: "Daily",
  W: "Weekly",
  M: "Monthly",
};

function TierTag({ tier }: { tier: string }) {
  const color = TIER_COLORS[tier] ?? "#888";
  return (
    <span
      className="text-[10px] font-semibold px-1.5 py-0.5 rounded"
      style={{ background: `${color}18`, color, border: `1px solid ${color}35` }}
    >
      {TIER_NAMES[tier] ?? tier}
    </span>
  );
}

function LoginTag() {
  return (
    <span
      className="text-[10px] font-semibold px-1.5 py-0.5 rounded"
      style={{ background: "rgba(255,165,0,0.1)", color: "#ffa500", border: "1px solid rgba(255,165,0,0.3)" }}
    >
      Login
    </span>
  );
}

// ---------------------------------------------------------------------------
// Progress overlay
// ---------------------------------------------------------------------------

interface ProgressState {
  active: boolean;
  percent: number;
  currentFile: string;
  label: string;
}

// ---------------------------------------------------------------------------
// Restore confirm dialog
// ---------------------------------------------------------------------------

function RestoreConfirmDialog({
  backup, serverRunning, onConfirm, onCancel,
}: {
  backup: BackupRow;
  serverRunning: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div
        className="glass-card rounded-2xl p-6 max-w-md w-full mx-4 space-y-4"
        style={{ border: "1px solid rgba(var(--neon-purple-rgb),0.3)" }}
      >
        <div className="flex items-center gap-3">
          <div
            className="w-10 h-10 rounded-full flex items-center justify-center shrink-0"
            style={{ background: "rgba(255,0,85,0.1)", border: "1px solid rgba(255,0,85,0.3)" }}
          >
            <AlertCircle className="w-5 h-5" style={{ color: "var(--neon-red)" }} />
          </div>
          <h3 className="text-base font-semibold" style={{ color: "var(--text-primary)" }}>
            Restore Backup
          </h3>
        </div>
        <p className="text-sm leading-relaxed" style={{ color: "var(--text-muted)" }}>
          This will{serverRunning ? " stop the server, " : " "}restore the backup from{" "}
          <span style={{ color: "var(--text-primary)" }}>{formatHumanDate(backup.created_at)}</span>
          {serverRunning ? ", then allow you to restart manually" : ""}.{" "}
          <strong style={{ color: "var(--neon-red)" }}>This cannot be undone.</strong>
        </p>
        <div className="flex gap-3 pt-1">
          <Button variant="outline" className="flex-1 cursor-pointer"
            style={{ border: "1px solid rgba(255,255,255,0.1)", color: "var(--text-muted)" }}
            onClick={onCancel}>Cancel</Button>
          <Button className="flex-1 cursor-pointer"
            style={{ background: "rgba(255,0,85,0.15)", border: "1px solid rgba(255,0,85,0.4)", color: "var(--neon-red)" }}
            onClick={onConfirm}>Restore</Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Full backup warning dialog
// ---------------------------------------------------------------------------

function FullBackupWarningDialog({
  estimatedSize, onConfirm, onNeverShow, onCancel,
}: {
  estimatedSize: number;
  onConfirm: () => void;
  onNeverShow: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div
        className="glass-card rounded-2xl p-6 max-w-lg w-full mx-4 space-y-4"
        style={{ border: "1px solid rgba(255,165,0,0.4)" }}
      >
        <div className="flex items-center gap-3">
          <div
            className="w-10 h-10 rounded-full flex items-center justify-center shrink-0"
            style={{ background: "rgba(255,165,0,0.1)", border: "1px solid rgba(255,165,0,0.3)" }}
          >
            <HardDrive className="w-5 h-5" style={{ color: "#ffa500" }} />
          </div>
          <h3 className="text-base font-semibold" style={{ color: "var(--text-primary)" }}>
            Full Backup Warning
          </h3>
        </div>
        <p className="text-sm leading-relaxed" style={{ color: "var(--text-muted)" }}>
          A full backup copies the entire server installation (~
          <strong style={{ color: "var(--text-primary)" }}>{formatBytes(estimatedSize)}</strong>
          ). This can take several minutes and use significant disk space.
        </p>
        <div
          className="rounded-lg p-3 text-xs space-y-1"
          style={{ background: "rgba(255,165,0,0.06)", border: "1px solid rgba(255,165,0,0.2)", color: "var(--text-muted)" }}
        >
          <p>Recommendations:</p>
          <ul className="list-disc pl-4 space-y-0.5">
            <li>Keep 2–3 full backups maximum</li>
            <li>Run weekly or monthly at most</li>
            <li>Ensure at least {formatBytes(estimatedSize * 3)} free on backup drive</li>
          </ul>
        </div>
        <div className="flex gap-3 pt-1 flex-wrap items-center">
          <Button variant="outline" className="cursor-pointer"
            style={{ border: "1px solid rgba(255,255,255,0.1)", color: "var(--text-muted)" }}
            onClick={onCancel}>Cancel</Button>
          <button className="text-xs cursor-pointer ml-auto" style={{ color: "var(--text-muted)" }} onClick={onNeverShow}>
            Never show again
          </button>
          <Button className="cursor-pointer"
            style={{ background: "rgba(255,165,0,0.15)", border: "1px solid rgba(255,165,0,0.4)", color: "#ffa500" }}
            onClick={onConfirm}>Continue</Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// BackupRowCard — single backup entry
// ---------------------------------------------------------------------------

function BackupRowCard({
  backup, onRestore, onDelete, restoreDisabled,
}: {
  backup: BackupRow;
  onRestore: (b: BackupRow) => void;
  onDelete: (b: BackupRow) => void;
  restoreDisabled: boolean;
}) {
  const isLogin = backup.triggered_by === "login";
  const tiers = !isLogin && backup.tiers ? backup.tiers.split(",").filter(Boolean) : [];
  const fname = backup.file_path.split(/[\\/]/).pop() ?? backup.file_path;
  const displayName = backup.backup_type === "player" && backup.player_name
    ? backup.player_name
    : null;

  return (
    <div
      className="glass-card rounded-xl px-4 py-2.5 flex items-center gap-3"
      style={{ border: "1px solid rgba(var(--neon-purple-rgb),0.1)" }}
    >
      <div className="flex-1 min-w-0">
        {/* Tier tags + date */}
        <div className="flex items-center gap-1.5 flex-wrap">
          {isLogin ? <LoginTag /> : tiers.map((t) => <TierTag key={t} tier={t} />)}
          <span className="text-xs" style={{ color: "var(--text-primary)" }}>
            {formatHumanDate(backup.created_at)}
          </span>
        </div>
        {/* Size or player name */}
        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
          {displayName && (
            <span className="text-xs font-medium" style={{ color: "var(--text-muted)" }}>
              {displayName}
            </span>
          )}
          {backup.file_size_bytes > 0 && (
            <span className="text-xs" style={{ color: "var(--text-muted)" }}>
              {formatBytes(backup.file_size_bytes)}
            </span>
          )}
        </div>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <Button size="sm" variant="ghost" title="Restore" disabled={restoreDisabled}
          onClick={() => onRestore(backup)}
          className="h-7 w-7 p-0 cursor-pointer" style={{ color: "var(--neon-cyan)" }}>
          <RotateCcw className="w-3.5 h-3.5" />
        </Button>
        <Button size="sm" variant="ghost" title="Delete"
          onClick={() => onDelete(backup)}
          className="h-7 w-7 p-0 cursor-pointer" style={{ color: "var(--neon-red)" }}>
          <Trash2 className="w-3.5 h-3.5" />
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SectionHeader — title + [Backup X Now] (orange) + [Edit Schedule] (cyan)
// ---------------------------------------------------------------------------

function SectionHeader({
  icon: Icon, title, color, count, onEditSchedules, onManualBackup, isBusy, backupLabel,
}: {
  icon: React.ElementType;
  title: string;
  color: string;
  count: number;
  onEditSchedules?: () => void;
  onManualBackup: () => void;
  isBusy: boolean;
  backupLabel: string;
}) {
  return (
    <div
      className="flex items-center gap-3 px-4 py-3"
      style={{
        background: "rgba(var(--neon-purple-rgb),0.02)",
        borderBottom: "1px solid rgba(var(--neon-purple-rgb),0.08)",
      }}
    >
      <div
        className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0"
        style={{ background: `color-mix(in srgb, ${color} 10%, transparent)`, border: `1px solid color-mix(in srgb, ${color} 20%, transparent)` }}
      >
        <Icon className="w-3.5 h-3.5" style={{ color }} />
      </div>
      <span className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
        {title}
      </span>
      {count > 0 && (
        <span className="px-1.5 py-0.5 rounded text-xs" style={{ background: `color-mix(in srgb, ${color} 12%, transparent)`, color }}>
          {count}
        </span>
      )}
      <div className="flex items-center gap-2 ml-auto">
        <Button size="sm" onClick={onManualBackup} disabled={isBusy}
          className="h-7 gap-1.5 cursor-pointer"
          style={{
            background: "rgba(var(--neon-purple-rgb),0.1)",
            border: "1px solid rgba(var(--neon-purple-rgb),0.35)",
            color: "var(--neon-purple)",
          }}>
          <Plus className="w-3 h-3" /> {backupLabel}
        </Button>
        {onEditSchedules && (
          <Button size="sm" onClick={onEditSchedules}
            className="h-7 gap-1.5 cursor-pointer"
            style={{
              background: "rgba(var(--neon-purple-rgb),0.1)",
              border: "1px solid rgba(var(--neon-purple-rgb),0.35)",
              color: "var(--neon-purple)",
            }}>
            <CalendarClock className="w-3 h-3" /> Edit Schedule
          </Button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// BackupSectionPanel — always-open scrollable panel with 6-entry visible area
// ---------------------------------------------------------------------------

function BackupSectionPanel({
  icon: Icon, title, color, backups, loading, onRestore, onDelete, onManualBackup,
  onEditSchedules, restoreDisabled, backupLabel, children,
}: {
  icon: React.ElementType;
  title: string;
  color: string;
  backups: BackupRow[];
  loading: boolean;
  onRestore: (b: BackupRow) => void;
  onDelete: (b: BackupRow) => void;
  onManualBackup: () => void;
  onEditSchedules?: () => void;
  restoreDisabled: boolean;
  backupLabel: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="glass-card rounded-xl overflow-hidden" style={{ border: "1px solid rgba(var(--neon-purple-rgb),0.1)" }}>
      <SectionHeader
        icon={Icon} title={title} color={color}
        count={backups.length}
        onEditSchedules={onEditSchedules}
        onManualBackup={onManualBackup}
        isBusy={restoreDisabled}
        backupLabel={backupLabel}
      />
      <div className="overflow-y-auto" style={{ maxHeight: "312px" }}>
        <div className="p-3 space-y-1.5">
          {children}
          {loading ? (
            <div className="h-10 rounded-lg animate-pulse" style={{ background: "rgba(255,255,255,0.04)" }} />
          ) : backups.length === 0 ? (
            <p className="text-xs text-center py-4" style={{ color: "var(--text-muted)" }}>
              No backups yet
            </p>
          ) : backups.map((b) => (
            <BackupRowCard
              key={b.id} backup={b} onRestore={onRestore}
              onDelete={onDelete} restoreDisabled={restoreDisabled}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PlayerBackupSection — grouped by player, always open
// ---------------------------------------------------------------------------

function PlayerBackupSection({
  serverId, playerBackups, loading, onRestore, onDelete, restoreDisabled,
  onEditSchedules, onManualBackup,
}: {
  serverId: string;
  playerBackups: BackupRow[];
  loading: boolean;
  onRestore: (b: BackupRow) => void;
  onDelete: (b: BackupRow) => void;
  restoreDisabled: boolean;
  onEditSchedules?: () => void;
  onManualBackup: () => void;
}) {
  const [knownPlayers,   setKnownPlayers]   = useState<{ eosId: string; playerName: string }[]>([]);
  const [selectedEosId,  setSelectedEosId]  = useState("all");

  useEffect(() => {
    getKnownPlayers(serverId).then(setKnownPlayers).catch(() => {});
  }, [serverId, playerBackups.length]);

  const byPlayer: Record<string, BackupRow[]> = {};
  for (const b of playerBackups) {
    const id = b.player_eosid ?? "unknown";
    (byPlayer[id] ??= []).push(b);
  }

  const playersWithBackups = Object.keys(byPlayer).filter((id) => (byPlayer[id]?.length ?? 0) > 0);

  // Union of players with backups + known players (deduped)
  const allOptions: { eosId: string; name: string }[] = [
    ...playersWithBackups.map((id) => ({
      eosId: id,
      name:  knownPlayers.find((p) => p.eosId === id)?.playerName
             ?? playerBackups.find((b) => b.player_eosid === id)?.player_name
             ?? id,
    })),
    ...knownPlayers
      .filter((p) => !playersWithBackups.includes(p.eosId))
      .map((p) => ({ eosId: p.eosId, name: p.playerName })),
  ];
  const uniqueOptions = Array.from(new Map(allOptions.map((p) => [p.eosId, p])).values());

  const nameFor = (eosId: string) =>
    uniqueOptions.find((p) => p.eosId === eosId)?.name ?? eosId;

  const selectedBackups =
    selectedEosId === "all"
      ? null
      : (byPlayer[selectedEosId] ?? []).sort(
          (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        );

  return (
    <div className="glass-card rounded-xl overflow-hidden" style={{ border: "1px solid rgba(var(--neon-purple-rgb),0.1)" }}>
      <SectionHeader
        icon={User} title="Player Backups" color="var(--neon-cyan)"
        count={playersWithBackups.length}
        onEditSchedules={onEditSchedules}
        onManualBackup={onManualBackup}
        isBusy={restoreDisabled}
        backupLabel="Backup Players Now"
      />

      {/* Player filter dropdown */}
      {uniqueOptions.length > 0 && (
        <div className="px-3 py-2" style={{ borderBottom: "1px solid rgba(var(--neon-purple-rgb),0.08)" }}>
          <select
            value={selectedEosId}
            onChange={(e) => setSelectedEosId(e.target.value)}
            className="h-7 text-xs px-2 rounded w-full"
            style={{
              background: "rgba(0,0,0,0.4)",
              border: "1px solid rgba(var(--neon-purple-rgb),0.25)",
              color: "var(--text-primary)",
              outline: "none",
            }}
          >
            <option value="all">All Players</option>
            {uniqueOptions.map((p) => (
              <option key={p.eosId} value={p.eosId}>{p.name}</option>
            ))}
          </select>
        </div>
      )}

      <div className="overflow-y-auto" style={{ maxHeight: "312px" }}>
        <div className="p-3">
          {loading ? (
            <div className="h-10 rounded-lg animate-pulse" style={{ background: "rgba(255,255,255,0.04)" }} />
          ) : selectedEosId !== "all" ? (
            // Single-player view
            (selectedBackups ?? []).length === 0 ? (
              <p className="text-xs text-center py-4" style={{ color: "var(--text-muted)" }}>
                No backups yet
              </p>
            ) : (
              <div className="space-y-1.5">
                {(selectedBackups ?? []).map((b) => (
                  <BackupRowCard key={b.id} backup={b} onRestore={onRestore}
                    onDelete={onDelete} restoreDisabled={restoreDisabled} />
                ))}
              </div>
            )
          ) : playersWithBackups.length === 0 ? (
            <p className="text-xs text-center py-4" style={{ color: "var(--text-muted)" }}>
              No player backups yet
            </p>
          ) : (
            // All-players grouped view
            <div className="space-y-3">
              {playersWithBackups.map((eosId) => {
                const pBackups = (byPlayer[eosId] ?? []).sort(
                  (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
                );
                return (
                  <div key={eosId}>
                    <p className="text-xs font-semibold mb-1.5 px-1" style={{ color: "var(--neon-cyan)" }}>
                      {nameFor(eosId)}
                    </p>
                    <div className="space-y-1.5">
                      {pBackups.map((b) => (
                        <BackupRowCard key={b.id} backup={b} onRestore={onRestore}
                          onDelete={onDelete} restoreDisabled={restoreDisabled} />
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// IniBackupSection — always open, scrollable INI snapshots
// ---------------------------------------------------------------------------

function IniBackupSection({
  serverId, backupDir, installPath, isBusy, onBusyChange, onEditSchedules,
}: {
  serverId: string;
  backupDir: string;
  installPath: string;
  isBusy: boolean;
  onBusyChange: (b: boolean) => void;
  onEditSchedules?: () => void;
}) {
  const [snapshots, setSnapshots] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setSnapshots(await tauriCmd.listIniBackups(serverId, backupDir));
    } catch { /* ok */ } finally {
      setLoading(false);
    }
  }, [serverId, backupDir]);

  useEffect(() => { if (backupDir) load(); }, [load, backupDir]);

  async function handleRestore(timestamp: string) {
    onBusyChange(true);
    try {
      await tauriCmd.restoreIniBackup(`${backupDir}/${serverId}/ini/${timestamp}`, installPath, platform());
      toast.success(`Config restored from ${timestamp}.`);
    } catch (e) {
      toast.error(`INI restore failed: ${e}`);
    } finally {
      onBusyChange(false);
    }
  }

  async function handleDelete(timestamp: string) {
    try {
      await tauriCmd.deleteBackup(`${backupDir}/${serverId}/ini/${timestamp}`);
      setSnapshots((s) => s.filter((x) => x !== timestamp));
      toast.success("Config snapshot deleted.");
    } catch (e) {
      toast.error(`Delete failed: ${e}`);
    }
  }

  return (
    <div className="glass-card rounded-xl overflow-hidden" style={{ border: "1px solid rgba(var(--neon-purple-rgb),0.1)" }}>
      <div
        className="flex items-center gap-3 px-4 py-3"
        style={{ background: "rgba(var(--neon-purple-rgb),0.02)", borderBottom: "1px solid rgba(var(--neon-purple-rgb),0.08)" }}
      >
        <div
          className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0"
          style={{ background: "rgba(0,255,136,0.1)", border: "1px solid rgba(0,255,136,0.25)" }}
        >
          <FileText className="w-3.5 h-3.5" style={{ color: "var(--neon-green)" }} />
        </div>
        <div className="flex-1">
          <span className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
            Config (INI) Backups
          </span>
          <span className="text-xs ml-2" style={{ color: "var(--text-muted)" }}>
            auto-saved on config change
          </span>
        </div>
        {onEditSchedules && (
          <Button size="sm" onClick={onEditSchedules}
            className="h-7 gap-1.5 cursor-pointer ml-auto"
            style={{ background: "rgba(var(--neon-purple-rgb),0.1)", border: "1px solid rgba(var(--neon-purple-rgb),0.35)", color: "var(--neon-purple)" }}>
            <CalendarClock className="w-3 h-3" /> Edit Schedule
          </Button>
        )}
      </div>
      <div className="overflow-y-auto" style={{ maxHeight: "312px" }}>
        <div className="p-3 space-y-1.5">
          {loading ? (
            <div className="h-10 rounded-lg animate-pulse" style={{ background: "rgba(255,255,255,0.04)" }} />
          ) : snapshots.length === 0 ? (
            <p className="text-xs text-center py-4" style={{ color: "var(--text-muted)" }}>
              No snapshots yet — save the config to create one
            </p>
          ) : snapshots.map((snap) => (
            <div
              key={snap}
              className="glass-card rounded-xl px-4 py-2.5 flex items-center gap-3"
              style={{ border: "1px solid rgba(0,255,136,0.1)" }}
            >
              <FileText className="w-4 h-4 shrink-0" style={{ color: "var(--neon-green)" }} />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium font-mono" style={{ color: "var(--text-primary)" }}>
                  {snap}
                </p>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <Button size="sm" variant="ghost" title="Restore" disabled={isBusy}
                  onClick={() => handleRestore(snap)}
                  className="h-7 w-7 p-0 cursor-pointer" style={{ color: "var(--neon-cyan)" }}>
                  <RotateCcw className="w-3.5 h-3.5" />
                </Button>
                <Button size="sm" variant="ghost" title="Delete"
                  onClick={() => handleDelete(snap)}
                  className="h-7 w-7 p-0 cursor-pointer" style={{ color: "var(--neon-red)" }}>
                  <Trash2 className="w-3.5 h-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SyncConfirmDialog
// ---------------------------------------------------------------------------

function SyncConfirmDialog({
  importCount, onConfirm, onCancel,
}: {
  importCount: number;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div
        className="glass-card rounded-2xl p-6 max-w-sm w-full mx-4 space-y-4"
        style={{ border: "1px solid rgba(var(--neon-purple-rgb),0.3)" }}
      >
        <div className="flex items-center gap-3">
          <div
            className="w-10 h-10 rounded-full flex items-center justify-center shrink-0"
            style={{ background: "rgba(var(--neon-purple-rgb),0.1)", border: "1px solid rgba(var(--neon-purple-rgb),0.3)" }}
          >
            <HardDrive className="w-5 h-5" style={{ color: "var(--neon-purple)" }} />
          </div>
          <h3 className="text-base font-semibold" style={{ color: "var(--text-primary)" }}>
            Sync from Disk
          </h3>
        </div>
        <p className="text-sm leading-relaxed" style={{ color: "var(--text-muted)" }}>
          Found{" "}
          <span style={{ color: "var(--text-primary)" }}>
            {importCount} file{importCount !== 1 ? "s" : ""}
          </span>{" "}
          to import.
        </p>
        <div className="flex gap-3 pt-1">
          <Button variant="outline" className="flex-1 cursor-pointer"
            style={{ border: "1px solid rgba(255,255,255,0.1)", color: "var(--text-muted)" }}
            onClick={onCancel}>Cancel</Button>
          <Button className="flex-1 cursor-pointer"
            style={{ background: "rgba(var(--neon-purple-rgb),0.15)", border: "1px solid rgba(var(--neon-purple-rgb),0.4)", color: "var(--neon-purple)" }}
            onClick={onConfirm}>Import</Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// BackupsTab — main component
// ---------------------------------------------------------------------------

interface Props {
  server: ServerRow;
  onNavigateToAutomation?: () => void;
}

export function BackupsTab({ server, onNavigateToAutomation }: Props) {
  const mapPath = ARK_MAPS.find((m) => m.id === server.map_id)?.mapPath ?? "TheIsland_WP";

  const [serverBackups, setServerBackups] = useState<BackupRow[]>([]);
  const [playerBackups, setPlayerBackups] = useState<BackupRow[]>([]);
  const [fullBackups,   setFullBackups]   = useState<BackupRow[]>([]);
  const [loading, setLoading] = useState(true);

  const [progress, setProgress] = useState<ProgressState>({
    active: false, percent: 0, currentFile: "", label: "",
  });
  const [restoreTarget, setRestoreTarget]   = useState<BackupRow | null>(null);
  const [showFullWarning, setShowFullWarning] = useState(false);
  const [fullEstimate,    setFullEstimate]    = useState(0);
  const [backupDir,       setBackupDir]       = useState("");
  const [syncPending,     setSyncPending]     = useState<{ toImport: BackupRecord[] } | null>(null);
  const [syncing,         setSyncing]         = useState(false);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [srv, plr, ful, bdir] = await Promise.all([
        getServerBackupsByType(server.id, "server"),
        getServerBackupsByType(server.id, "player"),
        getServerBackupsByType(server.id, "full"),
        getAppSetting("backup_dir"),
      ]);
      setServerBackups(srv);
      setPlayerBackups(plr);
      setFullBackups(ful);
      setBackupDir(bdir ?? "");
    } catch (e) {
      toast.error(`Failed to load backups: ${e}`);
    } finally {
      setLoading(false);
    }
  }, [server.id]);

  useEffect(() => { loadAll(); }, [loadAll]);

  useTauriEvent<{ percent: number; currentFile: string; label: string }>(
    `backup://progress/${server.id}`,
    (payload) => {
      setProgress((p) => ({
        ...p,
        active: payload.percent < 100,
        percent: payload.percent,
        currentFile: payload.currentFile,
        label: payload.label,
      }));
      if (payload.percent >= 100) setTimeout(loadAll, 500);
    }
  );

  // ── Manual backup helpers ────────────────────────────────────────────────

  async function handleServerBackup() {
    if (!backupDir) { toast.error("Backup directory not configured."); return; }
    setProgress({ active: true, percent: 0, currentFile: "", label: "Starting server backup…" });
    try {
      const rec: BackupRecord = await tauriCmd.createServerBackup(
        server.id, server.name, server.install_path, mapPath, server.map_id, backupDir, "manual"
      );
      await insertBackup({
        id: rec.id, server_id: rec.serverId, file_path: rec.filePath,
        file_size_bytes: rec.fileSizeBytes, map_id: rec.mapId,
        triggered_by: "manual", created_at: rec.createdAt,
        backup_type: "server", tiers: "", player_eosid: null, player_name: null,
      });
      const keep = parseInt(await getAppSetting(`manual_backup_keep_${server.id}`) ?? "5", 10);
      await pruneManualBackups(server.id, "server", isNaN(keep) ? 5 : keep);
      toast.success("Server backup created.");
      await loadAll();
    } catch (e) {
      toast.error(`Backup failed: ${e}`);
    } finally {
      setProgress((p) => ({ ...p, active: false }));
    }
  }

  async function handleAllPlayersBackup() {
    if (!backupDir) { toast.error("Backup directory not configured."); return; }
    setProgress({ active: true, percent: 0, currentFile: "", label: "Starting player backups…" });
    try {
      const records = await tauriCmd.backupAllPlayers(
        server.id, server.name, server.install_path, mapPath, server.map_id, backupDir, "manual"
      );
      if (records.length === 0) {
        toast.info("No player profiles found to back up.");
        return;
      }
      const keep = parseInt(await getAppSetting(`manual_backup_keep_${server.id}`) ?? "5", 10);
      const keepN = isNaN(keep) ? 5 : keep;
      for (const rec of records) {
        await insertBackup({
          id: rec.id, server_id: rec.serverId, file_path: rec.filePath,
          file_size_bytes: rec.fileSizeBytes, map_id: rec.mapId,
          triggered_by: "manual", created_at: rec.createdAt,
          backup_type: "player", tiers: "",
          player_eosid: rec.playerEosid ?? null,
          player_name: rec.playerName ?? null,
        });
        if (rec.playerEosid) {
          await pruneManualBackups(server.id, "player", keepN);
        }
      }
      toast.success(`Backed up ${records.length} player profile${records.length === 1 ? "" : "s"}.`);
      await loadAll();
    } catch (e) {
      toast.error(`Player backup failed: ${e}`);
    } finally {
      setProgress((p) => ({ ...p, active: false }));
    }
  }

  async function handleFullBackupClick() {
    if (!backupDir) { toast.error("Backup directory not configured."); return; }
    const dismissed = await getAppSetting("full_backup_warning_dismissed");
    if (dismissed === "true") {
      await runFullBackup();
    } else {
      const size = await tauriCmd.estimateDirSize(server.install_path).catch(() => 0);
      setFullEstimate(size);
      setShowFullWarning(true);
    }
  }

  async function runFullBackup() {
    setShowFullWarning(false);
    setProgress({ active: true, percent: 0, currentFile: "", label: "Starting full backup…" });
    try {
      const rec: BackupRecord = await tauriCmd.createFullBackup(
        server.id, server.name, server.install_path, server.map_id, backupDir, "manual"
      );
      await insertBackup({
        id: rec.id, server_id: rec.serverId, file_path: rec.filePath,
        file_size_bytes: rec.fileSizeBytes, map_id: rec.mapId,
        triggered_by: "manual", created_at: rec.createdAt,
        backup_type: "full", tiers: "", player_eosid: null, player_name: null,
      });
      const keep = parseInt(await getAppSetting(`manual_backup_keep_${server.id}`) ?? "5", 10);
      await pruneManualBackups(server.id, "full", isNaN(keep) ? 5 : keep);
      toast.success("Full backup created.");
      await loadAll();
    } catch (e) {
      toast.error(`Full backup failed: ${e}`);
    } finally {
      setProgress((p) => ({ ...p, active: false }));
    }
  }

  // ── Restore ────────────────────────────────────────────────────────────────

  async function handleRestoreConfirmed() {
    if (!restoreTarget) return;
    const target = restoreTarget;
    setRestoreTarget(null);
    setProgress({ active: true, percent: 0, currentFile: "", label: "Restoring…" });
    try {
      if (server.status === "running") {
        setProgress((p) => ({ ...p, label: "Stopping server…" }));
        await tauriCmd.stopServer(server.id, true);
        await new Promise((r) => setTimeout(r, 2000));
      }
      if (target.backup_type === "server") {
        await tauriCmd.restoreServerBackup(server.id, target.file_path, server.install_path);
      } else if (target.backup_type === "player") {
        await tauriCmd.restorePlayerBackup(server.id, target.file_path, server.install_path, mapPath);
      } else if (target.backup_type === "full") {
        await tauriCmd.restoreFullBackup(server.id, target.file_path, server.install_path);
      }
      toast.success("Restore complete. Start the server manually to apply.");
    } catch (e) {
      toast.error(`Restore failed: ${e}`);
    } finally {
      setProgress((p) => ({ ...p, active: false }));
    }
  }

  // ── Delete ─────────────────────────────────────────────────────────────────

  async function handleDelete(backup: BackupRow) {
    try {
      await tauriCmd.deleteBackup(backup.file_path);
      await deleteBackupRecord(backup.id);
      await loadAll();
      toast.success("Backup deleted.");
    } catch (e) {
      toast.error(`Delete failed: ${e}`);
    }
  }

  // ── Sync from Disk ──────────────────────────────────────────────────────────

  async function handleSyncFromDisk() {
    if (!backupDir) { toast.error("Backup directory not configured."); return; }
    setSyncing(true);
    try {
      const diskRecords = await tauriCmd.scanBackupDir(server.id, backupDir, server.map_id);
      const [dbServer, dbPlayer, dbFull] = await Promise.all([
        getServerBackupsByType(server.id, "server"),
        getServerBackupsByType(server.id, "player"),
        getServerBackupsByType(server.id, "full"),
      ]);
      const allDb = [...dbServer, ...dbPlayer, ...dbFull];

      const diskPaths = new Set(diskRecords.map((r) => r.filePath));
      const dbPaths   = new Set(allDb.map((r) => r.file_path));

      // Silently remove stale DB records (files no longer on disk).
      for (const dbRec of allDb) {
        if (!diskPaths.has(dbRec.file_path)) {
          await deleteBackupRecord(dbRec.id).catch(() => {});
        }
      }

      // Find disk files not yet in DB.
      const toImport = diskRecords.filter((r) => !dbPaths.has(r.filePath));

      if (toImport.length === 0) {
        toast.info("Backups are up to date.");
        await loadAll();
        return;
      }

      setSyncPending({ toImport });
    } catch (e) {
      toast.error(`Scan failed: ${e}`);
    } finally {
      setSyncing(false);
    }
  }

  async function handleSyncConfirmed() {
    if (!syncPending) return;
    const { toImport } = syncPending;
    setSyncPending(null);
    setSyncing(true);
    try {
      for (const rec of toImport) {
        await insertBackup({
          id:              rec.id,
          server_id:       rec.serverId,
          file_path:       rec.filePath,
          file_size_bytes: rec.fileSizeBytes,
          map_id:          rec.mapId,
          triggered_by:    rec.triggeredBy,
          created_at:      rec.createdAt,
          backup_type:     rec.backupType,
          tiers:           rec.tiers ?? "",
          player_eosid:    rec.playerEosid ?? null,
          player_name:     rec.playerName ?? null,
        }).catch(() => {});
      }
      toast.success(`Imported ${toImport.length} backup${toImport.length !== 1 ? "s" : ""}.`);
      await loadAll();
    } catch (e) {
      toast.error(`Import failed: ${e}`);
    } finally {
      setSyncing(false);
    }
  }

  // ── Navigation helper — switch to automation tab then scroll to backup section
  function handleEditSchedule() {
    onNavigateToAutomation?.();
    setTimeout(() => {
      document.getElementById("backup-schedules-section")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 150);
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  const isBusy = progress.active;
  const editScheduleBtn = onNavigateToAutomation ? handleEditSchedule : undefined;

  return (
    <div className="space-y-4">
      {/* Progress overlay */}
      {progress.active && (
        <div className="glass-card rounded-xl p-4 space-y-2"
          style={{ border: "1px solid rgba(var(--neon-purple-rgb),0.3)" }}>
          <div className="flex items-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin shrink-0" style={{ color: "var(--neon-purple)" }} />
            <span className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>
              {progress.label}
            </span>
            <span className="ml-auto text-sm font-mono" style={{ color: "var(--neon-purple)" }}>
              {progress.percent.toFixed(0)}%
            </span>
          </div>
          <div className="h-1.5 rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,0.06)" }}>
            <div
              className="h-full rounded-full transition-all duration-200"
              style={{
                width: `${progress.percent}%`,
                background: "linear-gradient(90deg, var(--neon-purple), var(--neon-cyan))",
                boxShadow: "var(--glow-purple)",
              }}
            />
          </div>
          {progress.currentFile && (
            <p className="text-xs truncate font-mono" style={{ color: "var(--text-muted)" }}>
              {progress.currentFile}
            </p>
          )}
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Archive className="w-4 h-4" style={{ color: "var(--neon-purple)" }} />
          <h2 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>Backups</h2>
        </div>
        <Button size="sm" variant="outline" onClick={loadAll} disabled={loading}
          className="h-8 gap-1.5 cursor-pointer"
          style={{ border: "1px solid rgba(255,255,255,0.1)", color: "var(--text-muted)" }}>
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {/* INI backups */}
      {backupDir && (
        <IniBackupSection
          serverId={server.id}
          backupDir={backupDir}
          installPath={server.install_path}
          isBusy={isBusy}
          onBusyChange={(b) => setProgress((p) => ({ ...p, active: b }))}
          onEditSchedules={editScheduleBtn}
        />
      )}

      {/* Server backups */}
      <BackupSectionPanel
        icon={Archive} title="Server Backups" color="var(--neon-purple)"
        backups={serverBackups} loading={loading}
        onRestore={setRestoreTarget} onDelete={handleDelete}
        onManualBackup={handleServerBackup}
        onEditSchedules={editScheduleBtn}
        restoreDisabled={isBusy}
        backupLabel="Backup Server Now"
      />

      {/* Player backups */}
      <PlayerBackupSection
        serverId={server.id}
        playerBackups={playerBackups} loading={loading}
        onRestore={setRestoreTarget} onDelete={handleDelete}
        onManualBackup={handleAllPlayersBackup}
        onEditSchedules={editScheduleBtn}
        restoreDisabled={isBusy}
      />

      {/* Full backups */}
      <BackupSectionPanel
        icon={HardDrive} title="Full Backups" color="#ffa500"
        backups={fullBackups} loading={loading}
        onRestore={setRestoreTarget} onDelete={handleDelete}
        onManualBackup={handleFullBackupClick}
        onEditSchedules={editScheduleBtn}
        restoreDisabled={isBusy}
        backupLabel="Backup Full Now"
      />

      {/* Sync from Disk */}
      {backupDir && (
        <div className="flex justify-center pt-1">
          <Button
            size="sm" variant="outline" onClick={handleSyncFromDisk}
            disabled={syncing || isBusy}
            className="h-8 gap-2 cursor-pointer text-xs"
            style={{ border: "1px solid rgba(var(--neon-purple-rgb),0.2)", color: "var(--text-muted)" }}
          >
            {syncing
              ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Scanning…</>
              : <><HardDrive className="w-3.5 h-3.5" /> Sync from Disk</>
            }
          </Button>
        </div>
      )}

      {restoreTarget && (
        <RestoreConfirmDialog
          backup={restoreTarget}
          serverRunning={server.status === "running"}
          onConfirm={handleRestoreConfirmed}
          onCancel={() => setRestoreTarget(null)}
        />
      )}

      {showFullWarning && (
        <FullBackupWarningDialog
          estimatedSize={fullEstimate}
          onConfirm={runFullBackup}
          onNeverShow={async () => {
            await setAppSetting("full_backup_warning_dismissed", "true");
            await runFullBackup();
          }}
          onCancel={() => setShowFullWarning(false)}
        />
      )}

      {syncPending && (
        <SyncConfirmDialog
          importCount={syncPending.toImport.length}
          onConfirm={handleSyncConfirmed}
          onCancel={() => setSyncPending(null)}
        />
      )}
    </div>
  );
}
