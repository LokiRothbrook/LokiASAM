"use client";

/**
 * SchedulerManager — bridges the Rust scheduler and SQLite.
 *
 * On mount: hydrates the Rust scheduler from SQLite via syncSchedulesToRust().
 * On `scheduler://fired`: persists last_run / next_run to SQLite and re-syncs.
 */

import { useEffect } from "react";
import { toast } from "sonner";
import { useTauriEvent } from "@/hooks/useTauriEvent";
import { insertBackup, updateScheduleRun, getScheduleById, setAppSetting } from "@/lib/db";
import { getNextCronDate } from "@/components/shared/CronBuilder";
import { syncSchedulesToRust } from "@/lib/scheduler-sync";
import type { SchedulerFiredPayload } from "@/lib/tauri-commands";

export function SchedulerManager() {
  // Hydrate the Rust scheduler once the component mounts (DB is ready by this point).
  useEffect(() => {
    syncSchedulesToRust();
  }, []);

  useTauriEvent<SchedulerFiredPayload>("scheduler://fired", async (payload) => {
    const { scheduleId, serverName, scheduleType, success, error, backupRecord } = payload;

    // ── Global cache update check — synthetic entry, not in the schedules table ──
    if (scheduleType === "global_update_check") {
      // Update asa_last_checked so syncSchedulesToRust computes the correct
      // next_run_ms when it re-syncs below.
      await setAppSetting("asa_last_checked", new Date().toISOString());
      // The asa://update-check event (emitted by the Rust handler) drives the
      // per-server badge update and "update available" settings — no toast here.
      if (!success) {
        toast.error(`Auto update check failed: ${error ?? "unknown error"}`);
      }
      syncSchedulesToRust();
      return;
    }

    // Persist backup record to SQLite when a backup schedule fired.
    if (scheduleType === "backup" && backupRecord && success) {
      try {
        await insertBackup({
          id:              backupRecord.id,
          server_id:       backupRecord.serverId,
          file_path:       backupRecord.filePath,
          file_size_bytes: backupRecord.fileSizeBytes,
          map_id:          backupRecord.mapId,
          triggered_by:    backupRecord.triggeredBy,
          created_at:      backupRecord.createdAt,
        });
      } catch {
        // Non-fatal — backup file was created, just the DB record failed.
      }
    }

    // Update last_run / next_run in SQLite so the UI shows correct times.
    const lastRun = new Date().toISOString();
    try {
      const row = await getScheduleById(scheduleId);
      const nextDate = row ? getNextCronDate(row.cron_expression) : null;
      const nextRun = nextDate?.toISOString() ?? null;
      await updateScheduleRun(scheduleId, lastRun, nextRun);
    } catch {
      // Non-fatal.
    }

    // Show a toast notification.
    if (success) {
      const labels: Record<string, string> = {
        backup:    "Scheduled backup completed",
        restart:   "Scheduled restart completed",
        update:    "Scheduled update completed",
        broadcast: "Scheduled broadcast sent",
      };
      toast.success(`[${serverName}] ${labels[scheduleType] ?? "Schedule fired"}.`);
    } else {
      toast.error(`[${serverName}] Scheduled ${scheduleType} failed: ${error ?? "unknown error"}`);
    }

    // Re-sync so Rust gets the updated next_run_ms from the DB.
    syncSchedulesToRust();
  });

  return null;
}
