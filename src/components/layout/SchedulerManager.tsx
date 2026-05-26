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
import { insertBackup, updateScheduleRun, getScheduleById } from "@/lib/db";
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
    // Fetch the schedule to get the cron expression and compute the real next_run
    // up-front — avoids a null flash in the UI between update and re-sync.
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
        backup: "Scheduled backup completed",
        restart: "Scheduled restart completed",
        update: "Scheduled update completed",
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
