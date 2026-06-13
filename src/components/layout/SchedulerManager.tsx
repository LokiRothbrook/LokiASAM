"use client";

/**
 * SchedulerManager — bridges the Rust scheduler and SQLite.
 *
 * On mount: hydrates the Rust scheduler from SQLite via syncSchedulesToRust().
 * On `backup://tick`: runs hourly TimeShift backup logic for all running servers.
 * On `scheduler://fired`: persists last_run / next_run for non-backup schedules.
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
  upsertPlayerNames, getServer, getAppSetting, getServers, getServerSchedules,
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

/** Canonical priority order for tiers (most important first). */
const TIER_PRIORITY: Tier[] = ["M", "W", "D", "H"];

/** Maps tier letter to the unified config_json key. */
const TIER_TO_KEY: Record<Tier, string> = {
  H: "hourly", D: "daily", W: "weekly", M: "monthly",
};

/** Default keep-counts if not set in config. */
const TIER_DEFAULT_KEEP: Record<Tier, number> = { H: 24, D: 7, W: 4, M: 3 };

/**
 * How much time must elapse since the last backup with this tier before a new
 * one is considered "due". H is always due when the schedule fires (0ms).
 */
const TIER_THRESHOLD_MS: Record<Tier, number> = {
  H: 0,
  D: 24 * 3600_000,
  W: 7 * 24 * 3600_000,
  M: 30 * 24 * 3600_000,
};

interface TierCfg { enabled: boolean; keep: number; }

/**
 * Parse a backup schedule's config_json into per-tier settings.
 * Supports both the new unified format and the legacy single-tier format.
 */
function parseTierConfig(configJson: string): Record<string, TierCfg> {
  try {
    const cfg = JSON.parse(configJson) as Record<string, unknown>;
    if (cfg.hourly !== undefined || cfg.daily !== undefined ||
        cfg.weekly !== undefined || cfg.monthly !== undefined) {
      return cfg as Record<string, TierCfg>;
    }
    // Legacy single-tier format: { tier: "H", keep: 24 }
    if (typeof cfg.tier === "string") {
      const t = (cfg.tier as string).toUpperCase() as Tier;
      const key = TIER_TO_KEY[t];
      if (key) {
        return { [key]: { enabled: true, keep: (cfg.keep as number) ?? TIER_DEFAULT_KEEP[t] } };
      }
    }
  } catch { /* ignore */ }
  return {};
}

function removeTier(existing: string, tier: Tier): string {
  return (existing ? existing.split(",").filter(Boolean) : [])
    .filter((f) => f !== tier)
    .join(",");
}

/** Canonical tier-sorted suffix for a tiers string: M > W > D > H */
function tierSuffix(tiers: string): string {
  if (!tiers) return "";
  const active = tiers.split(",").filter(Boolean);
  const sorted = TIER_PRIORITY.filter((t) => active.includes(t));
  return sorted.length > 0 ? `-${sorted.join("")}` : "";
}

/**
 * Compute the new filename for a backup when its tiers string changes.
 * Strips any existing tier suffix then appends the new one.
 */
function computeRenamedPath(filePath: string, newTiers: string): string {
  const sep   = filePath.includes("\\") ? "\\" : "/";
  const parts = filePath.split(sep);
  const fname = parts[parts.length - 1];
  if (!fname.endsWith(".7z")) return filePath;

  const base = fname.replace(/-[MWDH]+\.7z$/, ".7z").replace(/\.7z$/, "");
  const newSuffix = tierSuffix(newTiers);
  parts[parts.length - 1] = `${base}${newSuffix}.7z`;
  return parts.join(sep);
}

/** Rename the backup file on disk if the path changes, then update the DB. */
async function applyTierRename(backup: BackupRow, newTiers: string): Promise<string> {
  const newPath = computeRenamedPath(backup.file_path, newTiers);
  if (newPath !== backup.file_path) {
    try {
      await tauriCmd.renameBackupFile(backup.file_path, newPath);
      await updateBackupFilePath(backup.id, newPath);
    } catch {
      // Non-fatal — DB tiers still updated.
    }
  }
  return newPath;
}

/**
 * Prune backups of a given tier, keeping at most `keepCount`.
 * For player backups, optionally scope to a specific player.
 */
async function pruneByTier(
  serverId: string,
  backupType: string,
  tier: Tier,
  keepCount: number,
  playerEosId?: string,
): Promise<void> {
  const backups = await getServerBackupsByType(serverId, backupType);
  const withTier = backups
    .filter((b) => {
      if (!b.tiers.split(",").includes(tier)) return false;
      if (playerEosId !== undefined && b.player_eosid !== playerEosId) return false;
      return true;
    })
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

// ---------------------------------------------------------------------------
// Handle a single BackupRecord from scheduler://fired
// ---------------------------------------------------------------------------

/**
 * Determine which tiers are due for this backup record, label the archive
 * accordingly, insert it into the DB, and prune each tier's rotation.
 *
 * Called once per backup record from the `backup://tick` handler.
 * For player backups, tier eligibility is checked per-player so each
 * player's rotation is independent.
 */
async function handleScheduledBackupRecord(
  rec: BackupRecord,
  serverId: string,
  cfg: Record<string, TierCfg>,
  backupType: string,
): Promise<void> {
  const bType = backupType;
  const eosId = rec.playerEosid ?? undefined;

  const allBackups = await getServerBackupsByType(serverId, bType);
  // For player backups, only consider backups for this specific player
  const relevantBackups = eosId
    ? allBackups.filter((b) => b.player_eosid === eosId)
    : allBackups;

  const now = Date.now();
  const dueTiers: Tier[] = [];

  for (const tier of TIER_PRIORITY) {
    const tierCfg = cfg[TIER_TO_KEY[tier]] as TierCfg | undefined;
    if (!tierCfg?.enabled) continue;

    if (tier === "H") {
      // Hourly is always due when the schedule fires
      dueTiers.push("H");
      continue;
    }

    const withTier  = relevantBackups.filter((b) => b.tiers.split(",").filter(Boolean).includes(tier));
    const lastTime  = withTier.length > 0
      ? Math.max(...withTier.map((b) => new Date(b.created_at).getTime()))
      : 0;

    if (now - lastTime >= TIER_THRESHOLD_MS[tier]) {
      dueTiers.push(tier);
    }
  }

  if (dueTiers.length === 0) {
    // No tier is due this hour — discard the archive
    try { await tauriCmd.deleteBackup(rec.filePath); } catch { /* best-effort */ }
    return;
  }

  const tiersString = TIER_PRIORITY.filter((t) => dueTiers.includes(t)).join(",");

  const renamedPath = computeRenamedPath(rec.filePath, tiersString);
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
      tiers:           tiersString,
      player_eosid:    eosId ?? null,
      player_name:     rec.playerName ?? null,
    });
  } catch { /* non-fatal */ }

  for (const tier of dueTiers) {
    const keep = (cfg[TIER_TO_KEY[tier]] as TierCfg | undefined)?.keep ?? TIER_DEFAULT_KEEP[tier];
    await pruneByTier(serverId, bType, tier, keep, eosId);
  }
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
  const loginBackupInFlight = useRef<Set<string>>(new Set());

  useTauriEvent<{ serverId: string; eosId: string; ip: string }>(
    "player://login-any",
    async ({ serverId, eosId, ip }) => {
      const key = `${serverId}:${eosId}`;
      if (loginBackupInFlight.current.has(key)) return;

      insertPlayerConnection(serverId, eosId, ip).catch(() => {});

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

  // Hourly wall-clock backup tick — Rust emits this at each :00:00 boundary.
  // All backup types (server + player) are handled here, not via the cron scheduler.
  const backupInFlight = useRef<Set<string>>(new Set());

  useTauriEvent<{ runningServerIds: string[] }>(
    "backup://tick",
    async ({ runningServerIds }) => {
      if (runningServerIds.length === 0) return;

      const [servers, backupDir] = await Promise.all([
        getServers(),
        getAppSetting("backup_dir"),
      ]);
      if (!backupDir) return;

      for (const server of servers) {
        if (!runningServerIds.includes(server.id)) continue;

        const schedules  = await getServerSchedules(server.id);
        const map        = ARK_MAPS.find((m) => m.id === server.map_id);
        const mapPath    = map?.mapPath ?? "TheIsland_WP";

        // ── Server backup ──────────────────────────────────────────────────
        const serverSched = schedules.find(
          (s) => s.schedule_type === "backup_server" && s.enabled === 1
        );
        if (serverSched) {
          const cfg        = parseTierConfig(serverSched.config_json ?? "{}");
          const anyEnabled = Object.values(cfg).some((t) => (t as TierCfg).enabled);
          const inFlightKey = `${server.id}:server`;
          if (anyEnabled && !backupInFlight.current.has(inFlightKey)) {
            backupInFlight.current.add(inFlightKey);
            try {
              const rec = await tauriCmd.createServerBackup(
                server.id, server.name, server.install_path,
                mapPath, server.map_id, backupDir, "schedule", "",
              );
              await handleScheduledBackupRecord(rec, server.id, cfg, "backup_server");
            } catch (e) {
              toast.error(`[${server.name}] Server backup failed: ${String(e)}`);
            } finally {
              backupInFlight.current.delete(inFlightKey);
            }
          }
        }

        // ── Player backup ──────────────────────────────────────────────────
        const playerSched = schedules.find(
          (s) => s.schedule_type === "backup_player" && s.enabled === 1
        );
        if (playerSched) {
          const cfg        = parseTierConfig(playerSched.config_json ?? "{}");
          const anyEnabled = Object.values(cfg).some((t) => (t as TierCfg).enabled);
          const inFlightKey = `${server.id}:player`;
          if (anyEnabled && !backupInFlight.current.has(inFlightKey)) {
            backupInFlight.current.add(inFlightKey);
            try {
              const recs = await tauriCmd.backupAllPlayers(
                server.id, server.name, server.install_path,
                mapPath, server.map_id, backupDir, "schedule",
              );
              for (const rec of recs) {
                await handleScheduledBackupRecord(rec, server.id, cfg, "backup_player");
              }
            } catch (e) {
              toast.error(`[${server.name}] Player backup failed: ${String(e)}`);
            } finally {
              backupInFlight.current.delete(inFlightKey);
            }
          }
        }
      }
    }
  );

  // Non-backup scheduler events: restart, broadcast, update, global_update_check.
  useTauriEvent<SchedulerFiredPayload>("scheduler://fired", async (payload) => {
    const { scheduleId, serverId, serverName, scheduleType, success, error } = payload;

    if (scheduleType === "global_update_check") {
      await setAppSetting("asa_last_checked", new Date().toISOString());
      if (!success) toast.error(`Auto update check failed: ${error ?? "unknown error"}`);
      syncSchedulesToRust();
      return;
    }

    const lastRun = new Date().toISOString();
    try {
      const row      = await getScheduleById(scheduleId);
      const nextDate = row ? getNextCronDate(row.cron_expression) : null;
      await updateScheduleRun(scheduleId, lastRun, nextDate?.toISOString() ?? null);
    } catch { /* non-fatal */ }

    if (success) {
      const labels: Record<string, string> = {
        restart:   "Scheduled restart completed",
        update:    "Scheduled update completed",
        broadcast: "Scheduled broadcast sent",
      };
      if (labels[scheduleType]) {
        toast.success(`[${serverName}] ${labels[scheduleType]}.`);
      }
    } else {
      toast.error(`[${serverName}] Scheduled ${scheduleType} failed: ${error ?? "unknown error"}`);
    }

    syncSchedulesToRust();
  });

  return null;
}
