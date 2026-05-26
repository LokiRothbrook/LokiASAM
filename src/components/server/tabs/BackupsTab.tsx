"use client";

import { useState, useCallback } from "react";
import {
  Archive, Plus, Trash2, RotateCcw, FolderOpen,
  AlertCircle, CheckCircle2, Loader2, RefreshCw, HardDrive,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  getServerBackups, insertBackup, deleteBackupRecord,
  getAppSetting, setAppSetting, getServer,
  type BackupRow,
} from "@/lib/db";
import { tauriCmd } from "@/lib/tauri-commands";
import { useTauriEvent } from "@/hooks/useTauriEvent";
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

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function triggerBadge(trigger: string) {
  const map: Record<string, { label: string; color: string; bg: string }> = {
    manual:      { label: "Manual",     color: "var(--neon-cyan)",   bg: "rgba(0,255,255,0.08)"   },
    schedule:    { label: "Scheduled",  color: "var(--neon-purple)", bg: "rgba(191,0,255,0.08)"  },
    pre_update:  { label: "Pre-Update", color: "var(--neon-green)",  bg: "rgba(0,255,136,0.08)"  },
    pre_restart: { label: "Pre-Restart",color: "var(--neon-green)",  bg: "rgba(0,255,136,0.08)"  },
  };
  const s = map[trigger] ?? { label: trigger, color: "var(--text-muted)", bg: "transparent" };
  return (
    <span
      className="px-2 py-0.5 rounded text-xs font-medium"
      style={{ color: s.color, background: s.bg, border: `1px solid ${s.color}30` }}
    >
      {s.label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Restore confirm dialog
// ---------------------------------------------------------------------------

function RestoreConfirmDialog({
  backup,
  serverRunning,
  onConfirm,
  onCancel,
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
        style={{ border: "1px solid rgba(191,0,255,0.3)" }}
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
          This will{serverRunning ? " stop the server, " : " "}replace all save files with the backup from{" "}
          <span style={{ color: "var(--text-primary)" }}>{formatDate(backup.created_at)}</span>
          {serverRunning ? ", then restart the server" : ""}.{" "}
          <strong style={{ color: "var(--neon-red)" }}>This cannot be undone.</strong>
        </p>

        <p className="text-xs font-mono truncate" style={{ color: "var(--text-muted)" }}>
          {backup.file_path}
        </p>

        <div className="flex gap-3 pt-1">
          <Button
            variant="outline"
            className="flex-1 cursor-pointer"
            style={{ border: "1px solid rgba(255,255,255,0.1)", color: "var(--text-muted)" }}
            onClick={onCancel}
          >
            Cancel
          </Button>
          <Button
            className="flex-1 cursor-pointer"
            style={{
              background: "rgba(255,0,85,0.15)",
              border: "1px solid rgba(255,0,85,0.4)",
              color: "var(--neon-red)",
            }}
            onClick={onConfirm}
          >
            Restore
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// BackupsTab
// ---------------------------------------------------------------------------

interface Props {
  server: ServerRow;
}

interface ProgressState {
  active: boolean;
  percent: number;
  currentFile: string;
  label: string;
}

const RETENTION_COUNT_KEY = (id: string) => `backup_retention_count_${id}`;
const RETENTION_DAYS_KEY  = (id: string) => `backup_retention_days_${id}`;

export function BackupsTab({ server }: Props) {
  const [backups, setBackups] = useState<BackupRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [progress, setProgress] = useState<ProgressState>({ active: false, percent: 0, currentFile: "", label: "" });
  const [restoreTarget, setRestoreTarget] = useState<BackupRow | null>(null);
  const [retentionCount, setRetentionCount] = useState("10");
  const [retentionDays,  setRetentionDays]  = useState("30");
  const [retentionSaved, setRetentionSaved] = useState(false);

  // Load backups + retention settings on mount
  const loadBackups = useCallback(async () => {
    setLoading(true);
    try {
      const [rows, rCount, rDays] = await Promise.all([
        getServerBackups(server.id),
        getAppSetting(RETENTION_COUNT_KEY(server.id)),
        getAppSetting(RETENTION_DAYS_KEY(server.id)),
      ]);
      setBackups(rows);
      if (rCount) setRetentionCount(rCount);
      if (rDays)  setRetentionDays(rDays);
    } catch (e) {
      toast.error(`Failed to load backups: ${e}`);
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server.id]);

  // Kick off initial load
  useState(() => { loadBackups(); });

  // Listen for backup progress events
  useTauriEvent<{ percent: number; currentFile: string }>(
    `backup://progress/${server.id}`,
    (payload) => {
      setProgress((p) => ({ ...p, percent: payload.percent, currentFile: payload.currentFile }));
    }
  );

  // ── Create backup ──────────────────────────────────────────────────────────

  async function handleCreateBackup() {
    const backupDir = await getAppSetting("backup_dir");
    if (!backupDir) {
      toast.error("Backup directory not configured. Check Settings → Paths.");
      return;
    }

    setProgress({ active: true, percent: 0, currentFile: "", label: "Creating backup…" });
    try {
      const record: BackupRecord = await tauriCmd.createBackup(
        server.id,
        server.name,
        server.install_path,
        backupDir,
        server.map_id,
        "manual"
      );
      await insertBackup({
        id:              record.id,
        server_id:       record.serverId,
        file_path:       record.filePath,
        file_size_bytes: record.fileSizeBytes,
        map_id:          record.mapId,
        triggered_by:    record.triggeredBy,
        created_at:      record.createdAt,
      });
      toast.success("Backup created successfully.");
      await loadBackups();
      // Auto-prune after manual backup
      await pruneOldBackups();
    } catch (e) {
      toast.error(`Backup failed: ${e}`);
    } finally {
      setProgress((p) => ({ ...p, active: false }));
    }
  }

  // ── Delete backup ──────────────────────────────────────────────────────────

  async function handleDelete(backup: BackupRow) {
    try {
      await tauriCmd.deleteBackup(backup.file_path);
      await deleteBackupRecord(backup.id);
      setBackups((prev) => prev?.filter((b) => b.id !== backup.id) ?? null);
      toast.success("Backup deleted.");
    } catch (e) {
      toast.error(`Delete failed: ${e}`);
    }
  }

  // ── Restore backup ─────────────────────────────────────────────────────────

  async function handleRestoreConfirmed() {
    if (!restoreTarget) return;
    const target = restoreTarget;
    setRestoreTarget(null);

    const fresh = await getServer(server.id);
    const isRunning = fresh?.status === "running";

    setProgress({ active: true, percent: 0, currentFile: "", label: "Restoring backup…" });
    try {
      if (isRunning) {
        setProgress((p) => ({ ...p, label: "Stopping server…", currentFile: "" }));
        await tauriCmd.stopServer(server.id, true);
        // Brief pause to let process exit
        await new Promise((r) => setTimeout(r, 2000));
      }

      setProgress((p) => ({ ...p, label: "Restoring save files…" }));
      await tauriCmd.restoreBackup(server.id, target.file_path, server.install_path);

      if (isRunning) {
        setProgress((p) => ({ ...p, label: "Restarting server…", percent: 100, currentFile: "" }));
        // Restart needs full params — not available here, so notify user instead.
        toast.success("Restore complete. Start the server manually to apply the restored save.");
      } else {
        toast.success("Backup restored successfully.");
      }
    } catch (e) {
      toast.error(`Restore failed: ${e}`);
    } finally {
      setProgress((p) => ({ ...p, active: false }));
    }
  }

  // ── Retention prune ────────────────────────────────────────────────────────

  async function pruneOldBackups() {
    const allBackups = await getServerBackups(server.id);
    const maxCount = parseInt(retentionCount, 10) || 10;
    const maxDays  = parseInt(retentionDays,  10) || 30;
    const cutoff   = Date.now() - maxDays * 86_400_000;

    let toDelete = [...allBackups];
    toDelete.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

    // Remove backups older than maxDays
    const byAge = toDelete.filter((b) => new Date(b.created_at).getTime() < cutoff);
    // Also remove oldest beyond maxCount (excluding byAge already)
    const remaining = toDelete.filter((b) => !byAge.includes(b));
    const byCount = remaining.length > maxCount ? remaining.slice(0, remaining.length - maxCount) : [];

    const victims = [...new Set([...byAge, ...byCount])];
    for (const v of victims) {
      try {
        await tauriCmd.deleteBackup(v.file_path);
        await deleteBackupRecord(v.id);
      } catch {/* best-effort */}
    }
    if (victims.length > 0) {
      toast.info(`Auto-pruned ${victims.length} old backup${victims.length > 1 ? "s" : ""}.`);
      await loadBackups();
    }
  }

  async function handleSaveRetention() {
    await setAppSetting(RETENTION_COUNT_KEY(server.id), retentionCount);
    await setAppSetting(RETENTION_DAYS_KEY(server.id),  retentionDays);
    setRetentionSaved(true);
    setTimeout(() => setRetentionSaved(false), 2000);
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-4">

      {/* Progress overlay */}
      {progress.active && (
        <div
          className="glass-card rounded-xl p-4 space-y-2"
          style={{ border: "1px solid rgba(191,0,255,0.3)" }}
        >
          <div className="flex items-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin shrink-0" style={{ color: "var(--neon-purple)" }} />
            <span className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>
              {progress.label}
            </span>
            <span className="ml-auto text-sm font-mono" style={{ color: "var(--neon-purple)" }}>
              {progress.percent.toFixed(0)}%
            </span>
          </div>
          {/* Progress bar */}
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

      {/* Header row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Archive className="w-4 h-4" style={{ color: "var(--neon-purple)" }} />
          <h2 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
            Backups
          </h2>
          {backups && (
            <span
              className="px-1.5 py-0.5 rounded text-xs"
              style={{ background: "rgba(191,0,255,0.1)", color: "var(--neon-purple)" }}
            >
              {backups.length}
            </span>
          )}
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={loadBackups}
            disabled={loading}
            className="h-8 gap-1.5 cursor-pointer"
            style={{ border: "1px solid rgba(255,255,255,0.1)", color: "var(--text-muted)" }}
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
          </Button>
          <Button
            size="sm"
            onClick={handleCreateBackup}
            disabled={progress.active}
            className="h-8 gap-1.5 cursor-pointer"
            style={{
              background: "rgba(191,0,255,0.15)",
              border: "1px solid rgba(191,0,255,0.4)",
              color: "var(--neon-purple)",
            }}
          >
            <Plus className="w-3.5 h-3.5" />
            Create Backup
          </Button>
        </div>
      </div>

      {/* Backup list */}
      {loading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((n) => (
            <div key={n} className="glass-card rounded-xl h-16 animate-pulse" style={{ border: "1px solid rgba(191,0,255,0.1)" }} />
          ))}
        </div>
      ) : !backups || backups.length === 0 ? (
        <div
          className="glass-card rounded-xl p-10 flex flex-col items-center gap-3 text-center"
          style={{ border: "1px solid rgba(191,0,255,0.1)" }}
        >
          <HardDrive className="w-8 h-8" style={{ color: "var(--text-muted)" }} />
          <div>
            <p className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>No backups yet</p>
            <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>
              Click &ldquo;Create Backup&rdquo; to make your first save backup.
            </p>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {backups.map((backup) => (
            <div
              key={backup.id}
              className="glass-card rounded-xl px-4 py-3 flex items-center gap-3"
              style={{ border: "1px solid rgba(191,0,255,0.1)" }}
            >
              <Archive className="w-4 h-4 shrink-0" style={{ color: "var(--neon-purple)" }} />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate" style={{ color: "var(--text-primary)" }}>
                  {backup.file_path.split(/[\\/]/).pop() ?? backup.file_path}
                </p>
                <div className="flex items-center gap-3 mt-0.5">
                  <span className="text-xs" style={{ color: "var(--text-muted)" }}>
                    {formatDate(backup.created_at)}
                  </span>
                  <span className="text-xs" style={{ color: "var(--text-muted)" }}>
                    {formatBytes(backup.file_size_bytes)}
                  </span>
                  {triggerBadge(backup.triggered_by)}
                </div>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <Button
                  size="sm"
                  variant="ghost"
                  title="Restore this backup"
                  disabled={progress.active}
                  onClick={() => setRestoreTarget(backup)}
                  className="h-7 w-7 p-0 cursor-pointer"
                  style={{ color: "var(--neon-cyan)" }}
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  title="Delete this backup"
                  onClick={() => handleDelete(backup)}
                  className="h-7 w-7 p-0 cursor-pointer"
                  style={{ color: "var(--neon-red)" }}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Retention settings */}
      <div
        className="glass-card rounded-xl p-4 space-y-3"
        style={{ border: "1px solid rgba(191,0,255,0.1)" }}
      >
        <h3 className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
          Retention Policy
        </h3>
        <div className="flex flex-wrap gap-4 items-end">
          <div className="space-y-1">
            <label className="text-xs" style={{ color: "var(--text-muted)" }}>
              Keep last N backups
            </label>
            <Input
              type="number"
              min={1}
              max={100}
              value={retentionCount}
              onChange={(e) => setRetentionCount(e.target.value)}
              className="h-8 w-24 text-sm"
              style={{
                background: "rgba(0,0,0,0.4)",
                border: "1px solid rgba(191,0,255,0.2)",
                color: "var(--text-primary)",
              }}
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs" style={{ color: "var(--text-muted)" }}>
              Delete backups older than (days)
            </label>
            <Input
              type="number"
              min={1}
              max={365}
              value={retentionDays}
              onChange={(e) => setRetentionDays(e.target.value)}
              className="h-8 w-24 text-sm"
              style={{
                background: "rgba(0,0,0,0.4)",
                border: "1px solid rgba(191,0,255,0.2)",
                color: "var(--text-primary)",
              }}
            />
          </div>
          <Button
            size="sm"
            onClick={handleSaveRetention}
            className="h-8 gap-1.5 cursor-pointer"
            style={{
              background: retentionSaved ? "rgba(0,255,136,0.15)" : "rgba(191,0,255,0.15)",
              border: retentionSaved ? "1px solid rgba(0,255,136,0.4)" : "1px solid rgba(191,0,255,0.4)",
              color: retentionSaved ? "var(--neon-green)" : "var(--neon-purple)",
            }}
          >
            {retentionSaved ? (
              <><CheckCircle2 className="w-3.5 h-3.5" /> Saved</>
            ) : (
              "Save"
            )}
          </Button>
        </div>
        <p className="text-xs" style={{ color: "var(--text-muted)" }}>
          Old backups are pruned automatically after each new backup is created.
        </p>
      </div>

      {/* Restore confirm dialog */}
      {restoreTarget && (
        <RestoreConfirmDialog
          backup={restoreTarget}
          serverRunning={server.status === "running"}
          onConfirm={handleRestoreConfirmed}
          onCancel={() => setRestoreTarget(null)}
        />
      )}
    </div>
  );
}
