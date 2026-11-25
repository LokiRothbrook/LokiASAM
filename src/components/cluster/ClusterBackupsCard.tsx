"use client";

/**
 * ClusterBackupsCard — the cluster page's backup schedule, "Back up now", and
 * the list of cluster backups with restore / delete. Cluster backups hold the
 * shared transfer data (players' uploaded characters, dinos and items).
 */

import { useCallback, useState } from "react";
import { toast } from "sonner";
import { Archive, Loader2, RotateCcw, Trash2, Save, HardDriveDownload } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { BackupTiersEditor } from "@/components/shared/BackupTiersEditor";
import { useOnMount } from "@/hooks/useOnMount";
import { useSavedFlash } from "@/hooks/useSavedFlash";
import {
  getClusterBackups, getClusterBackupTiers, setClusterBackupTiers,
  type ClusterRow, type ClusterBackupRow, type BackupTierSettings, type ServerRow,
} from "@/lib/db";
import { tauriCmd } from "@/lib/tauri-commands";

function fmtSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

const TIER_NAMES: Record<string, string> = { M: "Monthly", W: "Weekly", D: "Daily", H: "Hourly" };

function originLabel(b: ClusterBackupRow): string {
  if (b.tiers) return b.tiers.split(",").map((t) => TIER_NAMES[t.trim()] ?? t).join(" · ");
  return b.triggered_by === "pre-restore" ? "Before restore" : "Manual";
}

export function ClusterBackupsCard({
  cluster,
  members,
  onSettingsSaved,
}: {
  cluster: ClusterRow;
  members: ServerRow[];
  /** Refresh the cluster row after the schedule is saved. */
  onSettingsSaved: () => void;
}) {
  const savedTiers = getClusterBackupTiers(cluster);
  const [tiers, setTiers] = useState<BackupTierSettings>(savedTiers);
  const [saving, setSaving] = useState(false);
  const [saved, triggerSaved] = useSavedFlash();
  const [backups, setBackups] = useState<ClusterBackupRow[] | null>(null);
  const [backingUp, setBackingUp] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<ClusterBackupRow | null>(null);
  const [restoring, setRestoring] = useState(false);

  const dirty = JSON.stringify(tiers) !== JSON.stringify(savedTiers);
  const running = members.filter((s) => s.status !== "stopped" && s.status !== "crashed" && s.status !== "start-failed");

  const clusterId = cluster.id;
  const load = useCallback(async () => {
    try { setBackups(await getClusterBackups(clusterId)); }
    catch (e) { toast.error(`Failed to load cluster backups: ${e}`); }
  }, [clusterId]);
  useOnMount(load);

  const saveTiers = async () => {
    setSaving(true);
    try {
      await setClusterBackupTiers(cluster.id, tiers);
      triggerSaved();
      onSettingsSaved();
    } catch (e) { toast.error(`Failed to save: ${e}`); }
    finally { setSaving(false); }
  };

  const backupNow = async () => {
    setBackingUp(true);
    try {
      await tauriCmd.createClusterBackup(cluster.id);
      toast.success("Cluster backed up.");
      await load();
    } catch (e) { toast.error(String(e)); }
    finally { setBackingUp(false); }
  };

  const restore = async () => {
    if (!restoreTarget) return;
    setRestoring(true);
    try {
      await tauriCmd.restoreClusterBackup(restoreTarget.id);
      toast.success("Cluster data restored. The previous data was backed up first.");
      setRestoreTarget(null);
      await load();
    } catch (e) { toast.error(String(e)); }
    finally { setRestoring(false); }
  };

  const remove = async (b: ClusterBackupRow) => {
    try {
      await tauriCmd.deleteClusterBackup(b.id);
      setBackups((list) => list?.filter((x) => x.id !== b.id) ?? null);
    } catch (e) { toast.error(`Delete failed: ${e}`); }
  };

  return (
    <div className="glass-card p-5 rounded-xl flex flex-col gap-4" style={{ border: "1px solid var(--border)" }}>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-sm font-semibold flex items-center gap-2" style={{ color: "var(--neon-purple)" }}>
            <Archive className="w-4 h-4" /> Cluster Backups
          </h2>
          <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>
            Players&apos; uploaded characters, dinos and items. Scheduled backups run while any server in the cluster is running.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={backupNow} disabled={backingUp}
          style={{ borderColor: "rgba(var(--neon-purple-rgb),0.3)", color: "var(--neon-purple)" }}>
          {backingUp ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <HardDriveDownload className="w-3.5 h-3.5 mr-1.5" />}
          Back up now
        </Button>
      </div>

      <div className="space-y-2">
        <BackupTiersEditor value={tiers} onChange={setTiers} />
        <div className="flex justify-end">
          <Button size="sm" className={saved ? "btn-neon-green" : "btn-neon-purple"} disabled={!dirty || saving} onClick={saveTiers}>
            <Save className="w-3.5 h-3.5 mr-1.5" />
            {saving ? "Saving…" : saved ? "Saved!" : "Save schedule"}
          </Button>
        </div>
      </div>

      <div className="space-y-1.5">
        {backups === null ? (
          <div className="h-10 rounded-lg animate-pulse" style={{ background: "var(--surface)" }} />
        ) : backups.length === 0 ? (
          <p className="text-xs text-center py-4" style={{ color: "var(--text-muted)" }}>
            No cluster backups yet.
          </p>
        ) : backups.map((b) => (
          <div key={b.id} className="flex items-center gap-3 px-3 py-2 rounded-lg"
            style={{ background: "var(--surface)", border: "1px solid rgba(var(--neon-purple-rgb),0.1)" }}>
            <div className="flex-1 min-w-0">
              <p className="text-sm" style={{ color: "var(--text-primary)" }}>{new Date(b.created_at).toLocaleString()}</p>
              <p className="text-xs" style={{ color: "var(--text-muted)" }}>{originLabel(b)} · {fmtSize(b.file_size_bytes)}</p>
            </div>
            <Button size="sm" variant="ghost" title={running.length ? "Stop the cluster's servers to restore" : "Restore"}
              disabled={running.length > 0} onClick={() => setRestoreTarget(b)}
              className="h-7 w-7 p-0" style={{ color: "var(--neon-cyan)" }}>
              <RotateCcw className="w-3.5 h-3.5" />
            </Button>
            <Button size="sm" variant="ghost" title="Delete" onClick={() => remove(b)}
              className="h-7 w-7 p-0" style={{ color: "var(--neon-red)" }}>
              <Trash2 className="w-3.5 h-3.5" />
            </Button>
          </div>
        ))}
        {running.length > 0 && backups && backups.length > 0 && (
          <p className="text-xs" style={{ color: "var(--text-subtle)" }}>
            Restoring needs every server in the cluster stopped ({running.map((s) => s.name).join(", ")} running).
          </p>
        )}
      </div>

      <Dialog open={!!restoreTarget} onOpenChange={(v) => { if (!v && !restoring) setRestoreTarget(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Restore cluster data?</DialogTitle>
            <DialogDescription>
              Replaces all uploaded characters, dinos and items in this cluster with the backup from{" "}
              {restoreTarget && new Date(restoreTarget.created_at).toLocaleString()}. The current data is backed up first, so this can be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setRestoreTarget(null)} disabled={restoring}>Cancel</Button>
            <Button size="sm" className="btn-neon-purple" onClick={restore} disabled={restoring}>
              {restoring ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5 mr-1.5" />}
              Restore
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
