"use client";

/**
 * ConfigHistoryDialog — browse the automatic INI snapshots taken before every
 * config save, see exactly which keys a snapshot would change, and restore it.
 */

import { useCallback, useState } from "react";
import { serverNotify } from "@/lib/notify";
import { History, RotateCcw, Loader2, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { useOnMount } from "@/hooks/useOnMount";
import { getAppSetting, type ServerRow } from "@/lib/db";
import { tauriCmd, type ServerConfigJson } from "@/lib/tauri-commands";
import { diffIniSections, type IniDiffEntry } from "@/lib/ini-utils";
import { restoreIniSnapshot } from "@/lib/server-config";

/** "2026-11-23_14-05-09" → local date/time; "current" → "Latest snapshot". */
function snapshotLabel(name: string): string {
  if (name === "current") return "Latest snapshot";
  const m = name.match(/^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})$/);
  if (!m) return name;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
  return d.toLocaleString();
}

export function ConfigHistoryDialog({
  server,
  currentConfig,
  hasUnsavedChanges,
  onClose,
  onRestored,
}: {
  server: ServerRow;
  /** What the editor currently holds — the "before" side of each diff. */
  currentConfig: ServerConfigJson;
  hasUnsavedChanges: boolean;
  onClose: () => void;
  onRestored: () => void;
}) {
  const sn = serverNotify(server);
  const [snapshots, setSnapshots] = useState<string[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [diff, setDiff] = useState<IniDiffEntry[] | null>(null);
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [backupBase, setBackupBase] = useState<string | null>(null);

  const load = useCallback(async () => {
    const backupDir = await getAppSetting("backup_dir");
    if (!backupDir) { setSnapshots([]); return; }
    const sep = backupDir.includes("\\") ? "\\" : "/";
    setBackupBase(`${backupDir}${sep}${server.id}${sep}ini${sep}`);
    setSnapshots(await tauriCmd.listIniBackups(server.id, backupDir).catch(() => []));
  }, [server.id]);
  useOnMount(load);

  async function preview(name: string) {
    if (!backupBase) return;
    setSelected(name);
    setDiff(null);
    setLoadingDiff(true);
    try {
      const snap = await tauriCmd.readIniFolder(`${backupBase}${name}`);
      setDiff([
        ...diffIniSections("gus", currentConfig.gameUserSettings, snap.gameUserSettings),
        ...diffIniSections("game", currentConfig.gameIni, snap.gameIni),
      ]);
    } catch (e) {
      sn.error(`Couldn't read snapshot: ${e}`);
    } finally {
      setLoadingDiff(false);
    }
  }

  async function restore() {
    if (!selected) return;
    setRestoring(true);
    try {
      const { warnings } = await restoreIniSnapshot(server, selected);
      warnings.forEach((w) => sn.warning(w));
      sn.success(`Config restored from ${snapshotLabel(selected)}. The previous config was snapshotted first.`);
      onRestored();
      onClose();
    } catch (e) {
      sn.error(`Restore failed: ${e}`);
    } finally {
      setRestoring(false);
    }
  }

  const fileLabel = (f: "gus" | "game") => (f === "gus" ? "GameUserSettings.ini" : "Game.ini");

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <History className="w-4 h-4" style={{ color: "var(--neon-purple)" }} />
            Config History
          </DialogTitle>
        </DialogHeader>
        <p className="text-xs" style={{ color: "var(--text-muted)" }}>
          A snapshot of the INI files is taken before every config save. Pick one to see what restoring it would change.
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-[220px_1fr] gap-3 min-h-[280px] max-h-[60vh]">
          <div className="overflow-y-auto space-y-1 pr-1">
            {snapshots === null ? (
              <Loader2 className="w-4 h-4 animate-spin" style={{ color: "var(--text-muted)" }} />
            ) : snapshots.length === 0 ? (
              <p className="text-xs" style={{ color: "var(--text-muted)" }}>No snapshots yet — one is taken on the next config save.</p>
            ) : snapshots.map((name) => (
              <button
                key={name}
                type="button"
                onClick={() => preview(name)}
                className="w-full text-left text-xs px-3 py-2 rounded-lg transition-colors"
                style={{
                  background: selected === name ? "rgba(var(--neon-purple-rgb),0.12)" : "var(--surface)",
                  border: `1px solid ${selected === name ? "rgba(var(--neon-purple-rgb),0.45)" : "rgba(var(--neon-purple-rgb),0.12)"}`,
                  color: selected === name ? "var(--neon-purple)" : "var(--text-primary)",
                }}
              >
                {snapshotLabel(name)}
              </button>
            ))}
          </div>

          <div className="overflow-y-auto rounded-lg p-3" style={{ background: "var(--surface)", border: "1px solid rgba(var(--neon-purple-rgb),0.12)" }}>
            {!selected ? (
              <p className="text-xs" style={{ color: "var(--text-muted)" }}>Select a snapshot.</p>
            ) : loadingDiff || !diff ? (
              <Loader2 className="w-4 h-4 animate-spin" style={{ color: "var(--text-muted)" }} />
            ) : diff.length === 0 ? (
              <p className="text-xs" style={{ color: "var(--text-muted)" }}>Identical to the current config.</p>
            ) : (
              <div className="space-y-1.5">
                <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                  Restoring changes {diff.length} setting{diff.length === 1 ? "" : "s"} (current <ArrowRight className="inline w-3 h-3" /> snapshot):
                </p>
                {diff.map((d) => (
                  <div key={`${d.file}.${d.section}.${d.key}`} className="text-xs font-mono rounded px-2 py-1"
                    style={{ background: "rgba(var(--neon-purple-rgb),0.04)" }}>
                    <div style={{ color: "var(--text-muted)" }}>{fileLabel(d.file)} [{d.section}]</div>
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span style={{ color: "var(--text-primary)" }}>{d.key}</span>
                      <span style={{ color: "var(--neon-red)" }}>{d.before ?? "(unset)"}</span>
                      <ArrowRight className="w-3 h-3 shrink-0" style={{ color: "var(--text-muted)" }} />
                      <span style={{ color: "var(--neon-green)" }}>{d.after ?? "(removed)"}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {hasUnsavedChanges && selected && (
          <p className="text-xs" style={{ color: "var(--neon-orange)" }}>
            You have unsaved changes in the editor — restoring discards them.
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>Close</Button>
          <Button size="sm" className="btn-neon-purple" disabled={!selected || restoring || diff?.length === 0} onClick={restore}>
            {restoring ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5 mr-1.5" />}
            Restore this snapshot
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
