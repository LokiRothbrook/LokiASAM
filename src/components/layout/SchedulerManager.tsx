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
import { syncSchedulesToRust, noteAutoUpdateFailure } from "@/lib/scheduler-sync";
import { runPerServerUpdateCheck, describeUpdatePlans } from "@/lib/update-utils";
import { useAppStore } from "@/store/useAppStore";
import type { SchedulerFiredPayload, UpdateCheckResult } from "@/lib/tauri-commands";

/** Toast id for the background update check — one toast that goes from
 *  "checking…" to the result, instead of a check that's only visible as a
 *  small TopBar spinner. */
const BG_CHECK_TOAST_ID = "asa-background-update-check";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SchedulerManager() {
  const queryClient = useQueryClient();
  const setAsaCacheOpLabel = useAppStore((s) => s.setAsaCacheOpLabel);

  // Scheduled background cache check start/stop — the manual "Check for
  // Updates" flow sets this same TopBar spinner state directly from JS
  // (runAsaCacheUpdate), but the background tick lives entirely in Rust, so
  // it needs this event to make the spinner (and any disabled buttons keyed
  // off it) reflect a check that's running in the background.
  useTauriEvent<{ running: boolean }>("asa://update-check/running", (payload) => {
    setAsaCacheOpLabel(payload.running ? "Checking ASA updates (background)…" : null);
    if (payload.running) {
      toast.loading("Checking for ASA server updates…", {
        id: BG_CHECK_TOAST_ID,
        description: "Automatic check — SteamCMD is updating the shared server cache.",
        duration: Infinity,
      });
    }
  });

  // SteamCMD only actually pulls bytes for part of a "check" run — most of it
  // is just validating manifests against Steam. Flip the TopBar label to make
  // that visible instead of leaving "Checking…" up for however long a real
  // download takes. Fires for every cache-check op regardless of who started
  // it (manual dashboard/Settings check or the background scheduled tick) —
  // they all stream through the shared "steamcmd://output/check" channel and
  // all funnel through this one global asaCacheOpLabel.
  useTauriEvent<{ line: string; stream: string }>("steamcmd://output/check", (payload) => {
    if (!/downloading/i.test(payload.line)) return;
    const current = useAppStore.getState().asaCacheOpLabel;
    if (!current?.startsWith("Checking ASA updates")) return;
    setAsaCacheOpLabel(
      current.includes("background") ? "Downloading ASA update (background)…" : "Downloading ASA update…"
    );
  });

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
        // Rust already cleared update_available in the DB — refresh the UI and
        // drop any stale per-server auto-update entry left in the scheduler
        // (e.g. a "Daily at Time" fire still queued for tonight), same reason
        // applyUpdateToServer() resyncs after a manual apply.
        queryClient.invalidateQueries({ queryKey: ["servers"] });
        syncSchedulesToRust();
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
        const summary = await runPerServerUpdateCheck(false);
        queryClient.invalidateQueries({ queryKey: ["servers"] });

        // Resolve the "checking…" toast with what was found and what will
        // happen about it. Newly flagged servers also get a bell notification
        // (from runPerServerUpdateCheck) carrying the same breakdown.
        const n = summary.allWithUpdates.length;
        if (n === 0) {
          toast.success("ASA servers are up to date", {
            id: BG_CHECK_TOAST_ID,
            description: `Automatic check finished — build ${r.latestBuildId}.`,
            duration: 6000,
          });
        } else {
          toast.info(`${n} server${n === 1 ? " needs" : "s need"} an update`, {
            id: BG_CHECK_TOAST_ID,
            description: describeUpdatePlans(summary.allWithUpdates),
            duration: 15000,
          });
        }
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
        toast.error("Automatic update check failed", {
          id: BG_CHECK_TOAST_ID,
          description: error ?? "unknown error",
          duration: 10000,
        });
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

    // Update results (start / success / failure) are reported by Rust as
    // real notifications (toast + bell), so they're not repeated here.
    if (scheduleType === "update") {
      if (!success) noteAutoUpdateFailure(payload.serverId);
    } else if (success) {
      if (scheduleType === "restart") {
        toast.success(`[${serverName}] Scheduled restart completed.`);
      }
    } else {
      toast.error(`[${serverName}] Scheduled ${scheduleType} failed: ${error ?? "unknown error"}`);
    }

    syncSchedulesToRust();
  });

  return null;
}
