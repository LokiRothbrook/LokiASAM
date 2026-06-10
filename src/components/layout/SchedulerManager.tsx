"use client";

/**
 * SchedulerManager — bridges the Rust scheduler and SQLite.
 *
 * On mount: hydrates the Rust scheduler from SQLite via syncSchedulesToRust().
 * On `scheduler://fired`: persists last_run / next_run to SQLite, inserts
 * backup records (with TimeShift tier logic), runs retention pruning, re-syncs.
 * On `rcon://players/{id}`: updates the player_name_map so player backups can
 * display human-readable names.
 */

import { useEffect } from "react";
import { toast } from "sonner";
import { useTauriEvent } from "@/hooks/useTauriEvent";
import {
  insertBackup, updateScheduleRun, getScheduleById, setAppSetting,
  getServerBackupsByType, updateBackupTiers, deleteBackupRecord,
  upsertPlayerNames,
  type BackupRow,
} from "@/lib/db";
import { tauriCmd } from "@/lib/tauri-commands";
import { getNextCronDate } from "@/components/shared/CronBuilder";
import { syncSchedulesToRust } from "@/lib/scheduler-sync";
import { ARK_MAPS } from "@/data/game-data";
import type { SchedulerFiredPayload } from "@/lib/tauri-commands";

// ---------------------------------------------------------------------------
// TimeShift helpers
// ---------------------------------------------------------------------------

type Tier = "H" | "D" | "W" | "M";

/** Parse config_json for the tier flag for this schedule entry. */
function parseTier(configJson: string): Tier {
  try {
    const cfg = JSON.parse(configJson) as { tier?: string };
    const t = (cfg.tier ?? "H").toUpperCase();
    if (t === "D" || t === "W" || t === "M") return t as Tier;
  } catch { /* fall through */ }
  return "H";
}

/** Parse keep count from config_json. */
function parseKeep(configJson: string, defaultKeep = 5): number {
  try {
    const cfg = JSON.parse(configJson) as { keep?: number };
    return typeof cfg.keep === "number" && cfg.keep > 0 ? cfg.keep : defaultKeep;
  } catch { return defaultKeep; }
}

/** Add a tier flag to a comma-separated tiers string without duplicating. */
function addTier(existing: string, tier: Tier): string {
  const flags = existing ? existing.split(",").filter(Boolean) : [];
  if (!flags.includes(tier)) flags.push(tier);
  return flags.sort().join(",");
}

/** Remove a tier flag from a comma-separated tiers string. */
function removeTier(existing: string, tier: Tier): string {
  return (existing ? existing.split(",").filter(Boolean) : [])
    .filter((f) => f !== tier)
    .join(",");
}

/**
 * TimeShift retention prune.
 *
 * For the given tier, if the count exceeds `keepCount`, strip the tier flag
 * from the oldest excess backups. If a backup then has no tier flags at all,
 * delete the file and DB record.
 */
async function pruneByTier(
  serverId: string,
  backupType: string,
  tier: Tier,
  keepCount: number,
): Promise<void> {
  const backups = await getServerBackupsByType(serverId, backupType);
  // Only backups that carry this tier flag, oldest first.
  const withTier = backups
    .filter((b) => b.tiers.split(",").includes(tier))
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

  if (withTier.length <= keepCount) return;

  const excess = withTier.slice(0, withTier.length - keepCount);
  for (const b of excess) {
    const newTiers = removeTier(b.tiers, tier);
    if (!newTiers) {
      // No tier flags remain — physically delete.
      try { await tauriCmd.deleteBackup(b.file_path); } catch { /* best-effort */ }
      await deleteBackupRecord(b.id);
    } else {
      await updateBackupTiers(b.id, newTiers);
    }
  }
}

/**
 * Try to promote an existing backup to a higher tier instead of creating a new
 * archive. Promotion succeeds if there is a backup of the given type whose
 * creation timestamp falls within `windowMs` of now.
 *
 * Returns the promoted backup (with updated tiers) or null if none found.
 */
async function tryPromote(
  serverId: string,
  backupType: string,
  tier: Tier,
  windowMs: number,
): Promise<BackupRow | null> {
  const backups = await getServerBackupsByType(serverId, backupType);
  // Most-recent backup that was created recently enough.
  const candidate = backups
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .find((b) => Date.now() - new Date(b.created_at).getTime() <= windowMs);

  if (!candidate) return null;

  const newTiers = addTier(candidate.tiers, tier);
  await updateBackupTiers(candidate.id, newTiers);
  return { ...candidate, tiers: newTiers };
}

// Promotion window per tier — how recent must an existing backup be to count?
const PROMOTE_WINDOW: Record<Tier, number> = {
  H: 0,        // never promote — always create new hourly
  D: 6 * 3600_000,   // promote if there's a backup within 6h
  W: 24 * 3600_000,  // promote if there's a backup within 24h
  M: 48 * 3600_000,  // promote if there's a backup within 48h
};

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

  useTauriEvent<SchedulerFiredPayload>("scheduler://fired", async (payload) => {
    const { scheduleId, serverName, scheduleType, success, error, backupRecord } = payload;

    // ── Global update check ─────────────────────────────────────────────────
    if (scheduleType === "global_update_check") {
      await setAppSetting("asa_last_checked", new Date().toISOString());
      if (!success) toast.error(`Auto update check failed: ${error ?? "unknown error"}`);
      syncSchedulesToRust();
      return;
    }

    // ── Backup schedule types ───────────────────────────────────────────────
    const isBackup = scheduleType === "backup_server"
      || scheduleType === "backup_player"
      || scheduleType === "backup_full";

    if (isBackup && success && backupRecord) {
      const row = await getScheduleById(scheduleId);
      const configJson = row?.config_json ?? "{}";
      const tier = parseTier(configJson);
      const keep = parseKeep(configJson, 5);
      const bType = backupRecord.backupType;

      // Determine final tiers for the new backup.
      let tiers = tier;

      // For D/W/M: if we can promote an existing backup, don't need the one
      // Rust just created (it was a "new backup" case, not promotion).
      // The Rust always creates a new file; we just tag it accordingly.
      if (tier !== "H") {
        const window = PROMOTE_WINDOW[tier];
        const promoted = await tryPromote(payload.serverId, bType, tier, window);
        if (promoted) {
          // A recent backup was promoted — delete the redundant new file Rust created.
          try { await tauriCmd.deleteBackup(backupRecord.filePath); } catch { /* ok */ }
          // Prune and re-sync without inserting the new record.
          await pruneByTier(payload.serverId, bType, tier, keep);
          const lastRun = new Date().toISOString();
          const nextDate = row ? getNextCronDate(row.cron_expression) : null;
          await updateScheduleRun(scheduleId, lastRun, nextDate?.toISOString() ?? null);
          syncSchedulesToRust();
          toast.success(`[${serverName}] ${tier}-tier backup promoted.`);
          return;
        }
        // No recent backup to promote — keep the new file Rust created.
        tiers = tier;
      }

      try {
        await insertBackup({
          id:              backupRecord.id,
          server_id:       backupRecord.serverId,
          file_path:       backupRecord.filePath,
          file_size_bytes: backupRecord.fileSizeBytes,
          map_id:          backupRecord.mapId,
          triggered_by:    backupRecord.triggeredBy,
          created_at:      backupRecord.createdAt,
          backup_type:     bType,
          tiers,
          player_eosid:    backupRecord.playerEosid ?? null,
          player_name:     backupRecord.playerName ?? null,
        });
      } catch {
        // Non-fatal — backup file exists even if DB insert failed.
      }

      await pruneByTier(payload.serverId, bType, tier, keep);
    }

    // ── Update last_run / next_run ──────────────────────────────────────────
    const lastRun = new Date().toISOString();
    try {
      const row = await getScheduleById(scheduleId);
      const nextDate = row ? getNextCronDate(row.cron_expression) : null;
      await updateScheduleRun(scheduleId, lastRun, nextDate?.toISOString() ?? null);
    } catch { /* non-fatal */ }

    if (success) {
      // Skipped-because-server-stopped: success=true but no backupRecord.
      // Don't toast — this is expected behaviour, not an event worth surfacing.
      const wasSkipped = isBackup && !backupRecord;
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
