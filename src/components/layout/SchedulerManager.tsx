"use client";

/**
 * SchedulerManager — bridges the Rust scheduler and SQLite.
 *
 * On mount: hydrates the Rust scheduler from SQLite via syncSchedulesToRust().
 * On `scheduler://fired`: persists last_run / next_run for non-backup schedules.
 *
 * Hourly backup ticks, player name tracking, login backup, and player connection
 * recording are all handled in Rust (backup_manager.rs, rcon.rs, log_manager.rs).
 */

import { useEffect } from "react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { useTauriEvent } from "@/hooks/useTauriEvent";
import {
  updateScheduleRun, getScheduleById, setAppSetting, rollupOldStats,
} from "@/lib/db";
import { getNextCronDate } from "@/components/shared/CronBuilder";
import { syncSchedulesToRust } from "@/lib/scheduler-sync";
import { runPerServerUpdateCheck } from "@/lib/update-utils";
import type { SchedulerFiredPayload, UpdateCheckResult } from "@/lib/tauri-commands";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SchedulerManager() {
  const queryClient = useQueryClient();

  useEffect(() => {
    syncSchedulesToRust();
    // Roll up + prune server_stats_history on startup — this was previously
    // dead code (never called anywhere), so raw stats samples accumulated
    // unbounded for the life of the install. Cheap/idempotent to run once
    // per app start; only does real work once ~daily since it only touches
    // rows older than 30 days.
    rollupOldStats().catch(() => {});
  }, []);

  // Background ASA cache/update results — fired for (1) the scheduled global
  // cache check and (2) per-server auto-update completion. Handled globally
  // (not page-scoped) so servers get flagged/cleared regardless of which page
  // is open when a background check or scheduled auto-update fires.
  useTauriEvent<UpdateCheckResult | { updateApplied?: boolean; serverId?: string }>(
    "asa://update-check",
    async (payload) => {
      if ("updateApplied" in payload && payload.updateApplied) {
        // Rust already cleared update_available in the DB — just refresh the UI.
        queryClient.invalidateQueries({ queryKey: ["servers"] });
        return;
      }
      if ("updateAvailable" in payload) {
        const r = payload as UpdateCheckResult;
        // latestBuildId is the cache's actual post-check content (cachedBuildId
        // is the pre-check value, kept only to report whether it changed).
        await Promise.all([
          setAppSetting("asa_cached_build_id", r.latestBuildId),
          setAppSetting("asa_latest_build_id", r.latestBuildId),
          setAppSetting("asa_last_checked", new Date().toISOString()),
        ]);
        await runPerServerUpdateCheck(false);
        queryClient.invalidateQueries({ queryKey: ["servers"] });
      }
    },
  );

  // Non-backup scheduler events: restart, broadcast, update, global_update_check.
  useTauriEvent<SchedulerFiredPayload>("scheduler://fired", async (payload) => {
    const { scheduleId, serverName, scheduleType, success, error } = payload;

    if (scheduleType === "global_update_check") {
      // On success this is already written by the asa://update-check handler
      // above (which also carries the actual build-id result) — only write
      // it here on failure, since fire_global_update_check returns before
      // ever emitting that event if the check itself errors out.
      if (!success) {
        await setAppSetting("asa_last_checked", new Date().toISOString());
        toast.error(`Auto update check failed: ${error ?? "unknown error"}`);
      }
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
        restart: "Scheduled restart completed",
        update:  "Scheduled update completed",
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
