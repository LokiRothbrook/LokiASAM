"use client";

/**
 * syncSchedulesToRust — build ScheduleEntry objects from SQLite and push them
 * to the Rust scheduler via sync_schedules.
 *
 * Called on app startup (SetupGuard), after any schedule CRUD (AutomationTab),
 * and after each scheduler://fired event (SchedulerManager).
 */

import { tauriCmd, type ScheduleEntry } from "@/lib/tauri-commands";
import {
  getServers, getServerSchedules, getServerMods, getServerConfig, getAppSetting,
} from "@/lib/db";
import { ensureMapsCacheLoaded, findMapById } from "@/lib/maps";
import { getNextCronDate } from "@/components/shared/CronBuilder";
import { launchArgsToExtraArgs } from "@/lib/server-utils";

function isTauriEnv(): boolean {
  return (
    typeof window !== "undefined" &&
    !!(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
  );
}

export async function syncSchedulesToRust(): Promise<void> {
  if (!isTauriEnv()) return;

  try {
    const [servers, steamcmdPath, baseDir, backupDir] = await Promise.all([
      getServers(),
      getAppSetting("steamcmd_path"),
      getAppSetting("base_dir"),
      getAppSetting("backup_dir"),
      ensureMapsCacheLoaded(),
    ]);

    const isLinux =
      typeof navigator !== "undefined" && !navigator.userAgent.includes("Windows");

    const [protonPath, prefixPath] = isLinux
      ? await Promise.all([
          getAppSetting("proton_path"),
          getAppSetting("proton_prefix_path"),
        ])
      : [null, null];

    const entries: ScheduleEntry[] = [];

    for (const server of servers) {
      const schedules = await getServerSchedules(server.id);
      const enabled = schedules.filter((s) => s.enabled === 1);
      if (enabled.length === 0) continue;

      const [config, mods] = await Promise.all([
        getServerConfig(server.id),
        getServerMods(server.id),
      ]);

      const launchArgs: Record<string, string> = config
        ? JSON.parse(config.launch_args_json)
        : {};
      const extraArgs = launchArgsToExtraArgs(launchArgs);

      const modIds = mods.filter((m) => m.enabled === 1).map((m) => m.mod_id);

      const map = findMapById(server.map_id);
      const mapPath = map?.mapPath ?? "TheIsland_WP";

      // Backup schedules are handled by the hourly backup://tick task in Rust,
      // NOT by the cron scheduler. Skip them here so they never double-fire.
      const BACKUP_TYPES = new Set(["backup_server", "backup_player", "backup_full"]);

      for (const schedule of enabled) {
        if (BACKUP_TYPES.has(schedule.schedule_type)) continue;
        // Compute next_run_ms from either the stored ISO date or fresh from cron.
        // IMPORTANT: never push a past timestamp — that causes Rust to fire immediately,
        // which re-fires backups that are still in progress (erases the u64::MAX guard).
        let nextRunMs: number;
        const storedTime = schedule.next_run
          ? new Date(schedule.next_run).getTime()
          : NaN;
        if (!isNaN(storedTime) && storedTime > Date.now()) {
          nextRunMs = storedTime;
        } else {
          // Stale, missing, or past — compute next strictly-future occurrence.
          const next = getNextCronDate(schedule.cron_expression);
          nextRunMs = next ? next.getTime() : Date.now() + 3_600_000;
        }

        entries.push({
          scheduleId: schedule.id,
          serverId: server.id,
          serverName: server.name,
          installPath: server.install_path,
          mapPath,
          mapId: server.map_id,
          port: server.port,
          queryPort: server.query_port,
          rconPort: server.rcon_port,
          rconPassword: server.admin_password,
          extraArgs,
          modIds,
          protonPath: protonPath ?? undefined,
          prefixPath: prefixPath ?? undefined,
          steamcmdPath: steamcmdPath ?? "",
          baseDir: baseDir ?? "",
          backupDir: backupDir ?? "",
          scheduleType: schedule.schedule_type,
          enabled: true,
          // Restart schedules no longer carry their own warning config — they
          // share the server's restart_warn_* fields with the manual Restart
          // button (same pattern the per-server Auto-Update entry below already
          // uses), so there's one warning message regardless of trigger.
          configJson: schedule.schedule_type === "restart"
            ? JSON.stringify({
                broadcastWarning: server.restart_warn_players === 1,
                warningMinutes:   server.restart_warn_minutes ?? 5,
                message:          server.restart_message || "Server restarting in {time}.",
                cancelMessage:    server.restart_cancel_message || "Restart has been canceled.",
              })
            : schedule.config_json ?? "{}",
          nextRunMs,
        });
      }
    }

    // ── Global auto-update-check entry ─────────────────────────────────────
    // Fires the shared cache update on startup and/or hourly, depending on
    // the asa_auto_check_hours setting:
    //   "startup"        — fire once ~30 s after launch
    //   "startup_hourly" — fire ~30 s after launch, then repeat every hour
    //   "disabled" / "0" — no scheduled check
    const [autoCheckMode, lastChecked] = await Promise.all([
      getAppSetting("asa_auto_check_hours"),
      getAppSetting("asa_last_checked"),
    ]);
    const mode = autoCheckMode ?? "disabled";
    const isStartupHourly = mode === "startup_hourly";
    const isStartup       = mode === "startup" || isStartupHourly;
    // Legacy numeric values ("1","6","12","24") treated as startup_hourly.
    const legacyHours     = parseInt(mode);
    const isLegacy        = !isNaN(legacyHours) && legacyHours > 0;

    if ((isStartup || isLegacy) && steamcmdPath && baseDir && servers.length > 0) {
      const intervalMs = isStartupHourly || isLegacy ? 3_600_000 : 0;
      // null means "don't schedule a global check this sync" — this must
      // never short-circuit the rest of the function (per-server auto-update
      // entries below still need to be built and sent regardless).
      let nextRunMs: number | null = null;
      if (!lastChecked) {
        // Never checked — fire 30 s after startup.
        nextRunMs = Date.now() + 30_000;
      } else if (isStartupHourly || isLegacy) {
        const scheduled = new Date(lastChecked).getTime() + intervalMs;
        // If overdue, give a 30-second startup buffer before firing.
        nextRunMs = scheduled < Date.now() ? Date.now() + 30_000 : scheduled;
      } else {
        // "startup" mode — only fire if we've never checked (handled above),
        // or if it's been at least 24h since the last check.
        const sinceLastCheck = Date.now() - new Date(lastChecked).getTime();
        if (sinceLastCheck >= 24 * 3_600_000) {
          nextRunMs = Date.now() + 30_000;
        }
      }

      if (nextRunMs !== null) entries.push({
        scheduleId:   "global-update-check",
        serverId:     "global",
        serverName:   "ASA Cache",
        installPath:  "",
        mapPath:      "",
        mapId:        "",
        port:         0,
        queryPort:    0,
        rconPort:     0,
        rconPassword: "",
        extraArgs:    [],
        modIds:       [],
        protonPath:   protonPath ?? undefined,
        prefixPath:   prefixPath ?? undefined,
        steamcmdPath: steamcmdPath ?? "",
        baseDir:      baseDir ?? "",
        backupDir:    "",
        scheduleType: "global_update_check",
        enabled:      true,
        configJson:   JSON.stringify({ intervalMs }),
        nextRunMs,
      });
    }

    // ── Per-server Auto-Update entries ──────────────────────────────────────
    // Synthesized (not stored as `schedules` rows) from each server's
    // update_automation_json, same pattern as the global-update-check entry
    // above. Reuses the existing fully-graceful `fire_update` handler in
    // scheduler.rs — countdown warning, SaveWorld+doexit, SteamCMD update,
    // sync, conditional restart — the same safe-shutdown path manual updates
    // already use. Only generated when there's actually an update available,
    // so this never restarts a server just to find nothing changed.
    if (steamcmdPath && baseDir) {
      for (const server of servers) {
        if (server.update_available !== 1) continue;
        if (server.status === "updating" || server.status === "installing") continue;

        let automation: { mode: "off" | "immediately" | "at_time"; update_time: string; restart_after_update: boolean; only_if_running: boolean };
        try {
          automation = { mode: "off", update_time: "03:00", restart_after_update: true, only_if_running: true, ...JSON.parse(server.update_automation_json || "{}") };
        } catch {
          continue;
        }
        if (automation.mode === "off") continue;

        let nextRunMs: number | null = null;
        if (automation.mode === "immediately") {
          nextRunMs = Date.now() + 15_000;
        } else if (automation.mode === "at_time") {
          const [h, m] = automation.update_time.split(":").map(Number);
          const cron = `${isNaN(m) ? 0 : m} ${isNaN(h) ? 3 : h} * * *`;
          const next = getNextCronDate(cron);
          nextRunMs = next ? next.getTime() : null;
        }
        if (nextRunMs === null) continue;

        const map = findMapById(server.map_id);
        const mapPath = map?.mapPath ?? "TheIsland_WP";

        entries.push({
          scheduleId:    `update-auto-${server.id}`,
          serverId:      server.id,
          serverName:    server.name,
          installPath:   server.install_path,
          mapPath,
          mapId:         server.map_id,
          port:          server.port,
          queryPort:     server.query_port,
          rconPort:      server.rcon_port,
          rconPassword:  server.admin_password,
          extraArgs:     [],
          modIds:        [],
          protonPath:    protonPath ?? undefined,
          prefixPath:    prefixPath ?? undefined,
          steamcmdPath:  steamcmdPath ?? "",
          baseDir:       baseDir ?? "",
          backupDir:     backupDir ?? "",
          scheduleType:  "update",
          enabled:       true,
          configJson: JSON.stringify({
            broadcastWarning:    server.update_warn_players === 1,
            warningMinutes:      server.update_warn_minutes ?? 5,
            skipIfPlayersOnline: false,
            restartAfterUpdate:  automation.restart_after_update,
            onlyIfRunning:       automation.only_if_running,
            message:             server.update_message || "Server going down for update in {time}.",
            cancelMessage:       server.update_cancel_message || "Update has been canceled.",
          }),
          nextRunMs,
        });
      }
    }

    await tauriCmd.syncSchedules(entries);
  } catch {
    // Non-fatal: scheduler will simply have no entries until next sync.
  }
}
