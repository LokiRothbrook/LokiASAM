"use client";

/**
 * SchedulerManager — bridges the Rust scheduler and SQLite.
 *
 * On mount: hydrates the Rust scheduler from SQLite via syncSchedulesToRust().
 * On `scheduler://fired`: persists last_run / next_run to SQLite, inserts
 * backup records (with TimeShift tier logic), runs retention pruning, re-syncs.
 * On `rcon://players-any`: updates the player_name_map.
 * On `player://login-any`: inserts player_connections record and triggers
 * login backups when enabled.
 */

import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { useTauriEvent } from "@/hooks/useTauriEvent";
import {
  insertBackup, updateScheduleRun, getScheduleById, setAppSetting,
  getServerBackupsByType, updateBackupTiers, deleteBackupRecord,
  upsertPlayerNames, getServer, getAppSetting,
  insertPlayerConnection, getLoginBackupCount, getOldestLoginBackup,
  updateBackupFilePath,
  type BackupRow,
} from "@/lib/db";
import { tauriCmd } from "@/lib/tauri-commands";
import { getNextCronDate } from "@/components/shared/CronBuilder";
import { syncSchedulesToRust } from "@/lib/scheduler-sync";
import { ARK_MAPS } from "@/data/game-data";
import type { SchedulerFiredPayload, BackupRecord } from "@/lib/tauri-commands";

// ---------------------------------------------------------------------------
// TimeShift helpers
// ---------------------------------------------------------------------------

type Tier = "H" | "D" | "W" | "M";

function parseTier(configJson: string): Tier {
  try {
    const cfg = JSON.parse(configJson) as { tier?: string };
    const t = (cfg.tier ?? "H").toUpperCase();
    if (t === "D" || t === "W" || t === "M") return t as Tier;
  } catch { /* fall through */ }
  return "H";
}

function parseKeep(configJson: string, defaultKeep = 5): number {
  try {
    const cfg = JSON.parse(configJson) as { keep?: number };
    return typeof cfg.keep === "number" && cfg.keep > 0 ? cfg.keep : defaultKeep;
  } catch { return defaultKeep; }
}

function addTier(existing: string, tier: Tier): string {
  const flags = existing ? existing.split(",").filter(Boolean) : [];
  if (!flags.includes(tier)) flags.push(tier);
  return flags.sort().join(",");
}

function removeTier(existing: string, tier: Tier): string {
  return (existing ? existing.split(",").filter(Boolean) : [])
    .filter((f) => f !== tier)
    .join(",");
}

/** Canonical tier-sorted suffix for a tiers string: M > W > D > H */
function tierSuffix(tiers: string): string {
  if (!tiers) return "";
  const order = ["M", "W", "D", "H"];
  const active = tiers.split(",").filter(Boolean);
  const sorted = order.filter((t) => active.includes(t));
  return sorted.length > 0 ? `-${sorted.join("")}` : "";
}

/**
 * Compute the new filename for a backup when its tiers string changes.
 * Handles both files with an existing tier suffix and those without.
 */
function computeRenamedPath(filePath: string, newTiers: string): string {
  const sep   = filePath.includes("\\") ? "\\" : "/";
  const parts = filePath.split(sep);
  const fname = parts[parts.length - 1];
  if (!fname.endsWith(".7z")) return filePath;

  // Strip old tier suffix pattern: -{MWDH chars}.7z → .7z
  const base = fname.replace(/-[MWDH]+\.7z$/, ".7z").replace(/\.7z$/, "");
  const newSuffix = tierSuffix(newTiers);
  parts[parts.length - 1] = `${base}${newSuffix}.7z`;
  return parts.join(sep);
}

/**
 * Rename the backup file on disk if the path changes, then update the DB.
 * Returns the final file path.
 */
async function applyTierRename(backup: BackupRow, newTiers: string): Promise<string> {
  const newPath = computeRenamedPath(backup.file_path, newTiers);
  if (newPath !== backup.file_path) {
    try {
      await tauriCmd.renameBackupFile(backup.file_path, newPath);
      await updateBackupFilePath(backup.id, newPath);
    } catch {
      // Non-fatal — DB tiers still updated; filename may be slightly stale.
    }
  }
  return newPath;
}

async function pruneByTier(
  serverId: string,
  backupType: string,
  tier: Tier,
  keepCount: number,
): Promise<void> {
  const backups = await getServerBackupsByType(serverId, backupType);
  const withTier = backups
    .filter((b) => b.tiers.split(",").includes(tier))
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

  if (withTier.length <= keepCount) return;

  const excess = withTier.slice(0, withTier.length - keepCount);
  for (const b of excess) {
    const newTiers = removeTier(b.tiers, tier);
    if (!newTiers) {
      try { await tauriCmd.deleteBackup(b.file_path); } catch { /* best-effort */ }
      await deleteBackupRecord(b.id);
    } else {
      await applyTierRename(b, newTiers);
      await updateBackupTiers(b.id, newTiers);
    }
  }
}

async function tryPromote(
  serverId: string,
  backupType: string,
  tier: Tier,
  windowMs: number,
): Promise<BackupRow | null> {
  const backups = await getServerBackupsByType(serverId, backupType);
  const candidate = backups
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .find((b) => Date.now() - new Date(b.created_at).getTime() <= windowMs);

  if (!candidate) return null;

  const newTiers = addTier(candidate.tiers, tier);
  await applyTierRename(candidate, newTiers);
  await updateBackupTiers(candidate.id, newTiers);
  return { ...candidate, tiers: newTiers };
}

const PROMOTE_WINDOW: Record<Tier, number> = {
  H: 0,
  D: 6 * 3600_000,
  W: 24 * 3600_000,
  M: 48 * 3600_000,
};

// ---------------------------------------------------------------------------
// Handle a single BackupRecord from scheduler://fired
// ---------------------------------------------------------------------------

async function handleScheduledBackupRecord(
  rec: BackupRecord,
  serverId: string,
  serverName: string,
  scheduleId: string,
): Promise<void> {
  const row        = await getScheduleById(scheduleId);
  const configJson = row?.config_json ?? "{}";
  const tier       = parseTier(configJson);
  const keep       = parseKeep(configJson, 5);
  const bType      = rec.backupType;

  let tiers = tier;

  if (tier !== "H") {
    const window   = PROMOTE_WINDOW[tier];
    const promoted = await tryPromote(serverId, bType, tier, window);
    if (promoted) {
      try { await tauriCmd.deleteBackup(rec.filePath); } catch { /* ok */ }
      await pruneByTier(serverId, bType, tier, keep);
      const lastRun  = new Date().toISOString();
      const nextDate = row ? getNextCronDate(row.cron_expression) : null;
      await updateScheduleRun(scheduleId, lastRun, nextDate?.toISOString() ?? null);
      syncSchedulesToRust();
      toast.success(`[${serverName}] ${tier}-tier backup promoted.`);
      return;
    }
    tiers = tier;
  }

  // Rename the newly created file to include the tier suffix.
  const initialTiers = tiers;
  const renamedPath  = computeRenamedPath(rec.filePath, initialTiers);
  if (renamedPath !== rec.filePath) {
    try { await tauriCmd.renameBackupFile(rec.filePath, renamedPath); } catch { /* ok */ }
  }

  try {
    await insertBackup({
      id:              rec.id,
      server_id:       rec.serverId,
      file_path:       renamedPath,
      file_size_bytes: rec.fileSizeBytes,
      map_id:          rec.mapId,
      triggered_by:    rec.triggeredBy,
      created_at:      rec.createdAt,
      backup_type:     bType,
      tiers:           initialTiers,
      player_eosid:    rec.playerEosid ?? null,
      player_name:     rec.playerName ?? null,
    });
  } catch {
    // Non-fatal.
  }

  await pruneByTier(serverId, bType, tier, keep);
}

// ---------------------------------------------------------------------------
// Platform helper
// ---------------------------------------------------------------------------

function platform(): string {
  return typeof navigator !== "undefined" && !navigator.userAgent.includes("Windows")
    ? "LinuxServer"
    : "WindowsServer";
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SchedulerManager() {
  useEffect(() => {
    syncSchedulesToRust();
  }, []);

  // Update player_name_map whenever RCON refreshes the player list.
  useTauriEvent<{ serverId?: string; players?: { name: string; playerId: string }[] }>(
    "rcon://players-any",
    async (payload) => {
      if (!payload.serverId || !payload.players?.length) return;
      await upsertPlayerNames(
        payload.serverId,
        payload.players.map((p) => ({ eosId: p.playerId, name: p.name })),
      ).catch(() => {});
    }
  );

  // Login event from log watcher — record connection + trigger login backup.
  const loginBackupInFlight = useRef<Set<string>>(new Set()); // dedup per "serverId:eosId"

  useTauriEvent<{ serverId: string; eosId: string; ip: string }>(
    "player://login-any",
    async ({ serverId, eosId, ip }) => {
      const key = `${serverId}:${eosId}`;
      if (loginBackupInFlight.current.has(key)) return;

      // Record the connection regardless of backup config.
      insertPlayerConnection(serverId, eosId, ip).catch(() => {});

      // Check if login backups are enabled for this server.
      const keepStr = await getAppSetting(`login_backup_keep_${serverId}`).catch(() => null);
      const keep    = parseInt(keepStr ?? "0", 10);
      if (keep <= 0) return;

      loginBackupInFlight.current.add(key);
      try {
        const server    = await getServer(serverId);
        if (!server) return;
        const backupDir = await getAppSetting("backup_dir");
        if (!backupDir) return;
        const mapPath = ARK_MAPS.find((m) => m.id === server.map_id)?.mapPath ?? "TheIsland_WP";

        const rec = await tauriCmd.createPlayerBackup(
          serverId, server.name, server.install_path,
          mapPath, server.map_id, backupDir,
          eosId, eosId, "login", "",
        );

        await insertBackup({
          id:              rec.id,
          server_id:       rec.serverId,
          file_path:       rec.filePath,
          file_size_bytes: rec.fileSizeBytes,
          map_id:          rec.mapId,
          triggered_by:    "login",
          created_at:      rec.createdAt,
          backup_type:     "player",
          tiers:           "",
          player_eosid:    eosId,
          player_name:     eosId,
        });

        // Prune: keep only the N most recent login backups for this player.
        const count = await getLoginBackupCount(serverId, eosId);
        if (count > keep) {
          const oldest = await getOldestLoginBackup(serverId, eosId);
          if (oldest) {
            try { await tauriCmd.deleteBackup(oldest.file_path); } catch { /* ok */ }
            await deleteBackupRecord(oldest.id);
          }
        }
      } catch {
        // Best-effort.
      } finally {
        loginBackupInFlight.current.delete(key);
      }
    }
  );

  useTauriEvent<SchedulerFiredPayload>("scheduler://fired", async (payload) => {
    const { scheduleId, serverId, serverName, scheduleType, success, error, backupRecords } = payload;

    if (scheduleType === "global_update_check") {
      await setAppSetting("asa_last_checked", new Date().toISOString());
      if (!success) toast.error(`Auto update check failed: ${error ?? "unknown error"}`);
      syncSchedulesToRust();
      return;
    }

    const isBackup = scheduleType === "backup_server"
      || scheduleType === "backup_player"
      || scheduleType === "backup_full";

    if (isBackup && success && backupRecords.length > 0) {
      for (const rec of backupRecords) {
        await handleScheduledBackupRecord(rec, serverId, serverName, scheduleId);
      }
    }

    const lastRun = new Date().toISOString();
    try {
      const row      = await getScheduleById(scheduleId);
      const nextDate = row ? getNextCronDate(row.cron_expression) : null;
      await updateScheduleRun(scheduleId, lastRun, nextDate?.toISOString() ?? null);
    } catch { /* non-fatal */ }

    if (success) {
      const wasSkipped = isBackup && backupRecords.length === 0;
      if (!wasSkipped) {
        const labels: Record<string, string> = {
          backup_server: "Server backup completed",
          backup_player: "Player backups completed",
          backup_full:   "Full backup completed",
          restart:       "Scheduled restart completed",
          update:        "Scheduled update completed",
          broadcast:     "Scheduled broadcast sent",
        };
        toast.success(`[${serverName}] ${labels[scheduleType] ?? "Schedule fired"}.`);
      }
    } else {
      toast.error(`[${serverName}] Scheduled ${scheduleType} failed: ${error ?? "unknown error"}`);
    }

    syncSchedulesToRust();
  });

  return null;
}
