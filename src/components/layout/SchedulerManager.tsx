"use client";

/**
 * SchedulerManager — mounts once in the root layout and fires due schedules.
 *
 * Every 60 seconds it queries all enabled schedules from SQLite, checks which
 * ones are due (next_run <= now), and executes the appropriate action:
 *   - backup   → create_backup Rust command
 *   - update   → update_server SteamCMD command
 *   - restart  → optional RCON broadcast, then restart_server
 *   - broadcast → rcon_send broadcast
 *
 * After firing, it updates last_run and computes the new next_run from the
 * cron expression. Schedules only fire while LokiASAM is running.
 */

import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { tauriCmd } from "@/lib/tauri-commands";
import {
  getServers, getServerSchedules, insertBackup,
  getAppSetting, updateScheduleRun,
  type ScheduleRow, type ServerRow,
} from "@/lib/db";
import { getNextCronDate } from "@/components/shared/CronBuilder";
import type { BackupRecord } from "@/lib/tauri-commands";

const TICK_MS = 60_000;

// ---------------------------------------------------------------------------
// Action executors
// ---------------------------------------------------------------------------

async function fireBackup(server: ServerRow, schedule: ScheduleRow) {
  const backupDir = await getAppSetting("backup_dir");
  if (!backupDir) return;

  try {
    const record: BackupRecord = await tauriCmd.createBackup(
      server.id,
      server.name,
      server.install_path,
      backupDir,
      server.map_id,
      "schedule"
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
    toast.success(`[${server.name}] Scheduled backup completed.`);
  } catch (e) {
    toast.error(`[${server.name}] Scheduled backup failed: ${e}`);
  }
}

async function fireBroadcast(server: ServerRow, schedule: ScheduleRow) {
  const cfg = JSON.parse(schedule.config_json || "{}") as { message?: string };
  const message = cfg.message ?? "Server broadcast.";
  try {
    await tauriCmd.rconSend(server.id, `Broadcast ${message}`);
  } catch {
    // Server might be offline — silently ignore broadcast failures.
  }
}

async function fireRestart(server: ServerRow, schedule: ScheduleRow) {
  const cfg = JSON.parse(schedule.config_json || "{}") as {
    broadcastWarning?: boolean;
    warningMinutes?: number;
    message?: string;
  };

  if (server.status !== "running") return;

  if (cfg.broadcastWarning && cfg.warningMinutes && cfg.warningMinutes > 0) {
    const msg = (cfg.message ?? "Server restarting in {minutes} minutes.")
      .replace("{minutes}", String(cfg.warningMinutes));
    try {
      await tauriCmd.rconSend(server.id, `Broadcast ${msg}`);
    } catch {/* ignore */}
    await new Promise((r) => setTimeout(r, cfg.warningMinutes! * 60_000));
  }

  try {
    await tauriCmd.stopServer(server.id, true);
    toast.info(`[${server.name}] Scheduled restart: server stopped. Restart it manually or via start.`);
  } catch (e) {
    toast.error(`[${server.name}] Scheduled restart failed: ${e}`);
  }
}

async function fireUpdate(server: ServerRow, schedule: ScheduleRow) {
  const cfg = JSON.parse(schedule.config_json || "{}") as {
    broadcastWarning?: boolean;
    warningMinutes?: number;
    message?: string;
  };

  const [steamcmdPath, baseDir] = await Promise.all([
    getAppSetting("steamcmd_path"),
    getAppSetting("base_dir"),
  ]);
  if (!steamcmdPath || !baseDir) return;
  const sep = baseDir.includes("\\") ? "\\" : "/";
  const cacheDir = `${baseDir}${sep}lokiasam${sep}cache${sep}asa-server`;

  if (server.status === "running" && cfg.broadcastWarning && cfg.warningMinutes && cfg.warningMinutes > 0) {
    const msg = (cfg.message ?? "Server updating in {minutes} minutes.")
      .replace("{minutes}", String(cfg.warningMinutes));
    try {
      await tauriCmd.rconSend(server.id, `Broadcast ${msg}`);
    } catch {/* ignore */}
    await new Promise((r) => setTimeout(r, cfg.warningMinutes! * 60_000));
  }

  if (server.status === "running") {
    try { await tauriCmd.stopServer(server.id, true); } catch {/* ignore */}
    await new Promise((r) => setTimeout(r, 3000));
  }

  try {
    await tauriCmd.updateServer(server.id, server.install_path, cacheDir, steamcmdPath);
    toast.success(`[${server.name}] Scheduled update completed.`);
  } catch (e) {
    toast.error(`[${server.name}] Scheduled update failed: ${e}`);
  }
}

// ---------------------------------------------------------------------------
// SchedulerManager component
// ---------------------------------------------------------------------------

const ACTIONS: Record<string, (server: ServerRow, schedule: ScheduleRow) => Promise<void>> = {
  backup:    fireBackup,
  broadcast: fireBroadcast,
  restart:   fireRestart,
  update:    fireUpdate,
};

export function SchedulerManager() {
  const firingRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    let mounted = true;

    async function tick() {
      if (!mounted) return;
      const now = Date.now();

      let servers: ServerRow[];
      try {
        servers = await getServers();
      } catch {
        return;
      }

      for (const server of servers) {
        let schedules: ScheduleRow[];
        try {
          schedules = await getServerSchedules(server.id);
        } catch {
          continue;
        }

        for (const schedule of schedules) {
          if (schedule.enabled !== 1) continue;
          if (!schedule.next_run) continue;
          if (firingRef.current.has(schedule.id)) continue;

          const nextMs = new Date(schedule.next_run).getTime();
          if (isNaN(nextMs) || nextMs > now) continue;

          const action = ACTIONS[schedule.schedule_type];
          if (!action) continue;

          firingRef.current.add(schedule.id);
          // Update timestamps first so the schedule isn't fired twice.
          const lastRun = new Date(now).toISOString();
          const nextDate = getNextCronDate(schedule.cron_expression);
          const nextRun  = nextDate?.toISOString() ?? lastRun;
          try {
            await updateScheduleRun(schedule.id, lastRun, nextRun);
          } catch {/* non-fatal */}

          action(server, schedule).finally(() => {
            firingRef.current.delete(schedule.id);
          });
        }
      }
    }

    // Initial tick after a short delay (let DB hydrate on startup).
    const initialTimer = setTimeout(tick, 5000);
    const interval = setInterval(tick, TICK_MS);

    return () => {
      mounted = false;
      clearTimeout(initialTimer);
      clearInterval(interval);
    };
  }, []);

  return null;
}
