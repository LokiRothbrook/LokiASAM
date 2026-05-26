"use client";

/**
 * SchedulerManager — thin event listener for the Rust-side scheduler.
 *
 * The heavy lifting (cron tick, process management, backup, restart, update)
 * all happens in a Tokio background task in Rust — immune to JS timer throttling
 * when the window is minimised to tray.
 *
 * This component's only job:
 *   1. Call syncSchedulesToRust() on mount so the Rust scheduler is hydrated.
 *   2. Listen for `scheduler://fired` events, persist the result to SQLite
 *      (last_run / next_run), and re-sync so the Rust scheduler gets the
 *      fresh next_run timestamp.
 */

import { useEffect } from "react";
import { toast } from "sonner";
import { useTauriEvent } from "@/hooks/useTauriEvent";
import { insertBackup, updateScheduleRun } from "@/lib/db";
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
    // We need the cron expression to compute next_run — re-query is expensive,
    // so we let syncSchedulesToRust (called below) re-read and pass the correct
    // next_run_ms back to Rust. For the SQLite update we just advance from now.
    const lastRun = new Date().toISOString();
    // We don't have the cron expression here; syncSchedulesToRust will recompute
    // it from the stored next_run. Set next_run to null temporarily so it gets
    // recomputed on the next sync rather than firing again immediately.
    try {
      await updateScheduleRun(scheduleId, lastRun, null);
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
