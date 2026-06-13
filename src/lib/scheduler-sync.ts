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
  setAppSetting,
} from "@/lib/db";
import { ARK_MAPS, LAUNCH_PARAMETERS } from "@/data/game-data";
import { getNextCronDate } from "@/components/shared/CronBuilder";

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
      const enabled = schedules.filter((s) => s.enabled === 1 && s.next_run);
      if (enabled.length === 0) continue;

      const [config, mods] = await Promise.all([
        getServerConfig(server.id),
        getServerMods(server.id),
      ]);

      const launchArgs: Record<string, string> = config
        ? JSON.parse(config.launch_args_json)
        : {};
      const extraArgs = Object.entries(launchArgs).flatMap(([k, v]) => {
        if (!v || v === "false" || v === "0") return [];
        const param = LAUNCH_PARAMETERS.find((p) => p.key === k);
        if (param?.type === "boolean") return v === "true" ? [param.flag] : [];
        if (param) return v ? [`${param.flag}${v}`] : [];
        return v === "true" ? [`-${k}`] : [`-${k}=${v}`];
      });

      const modIds = mods.filter((m) => m.enabled === 1).map((m) => m.mod_id);

      const map = ARK_MAPS.find((m) => m.id === server.map_id);
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
          rconPassword: server.rcon_password,
          extraArgs,
          modIds,
          protonPath: protonPath ?? undefined,
          prefixPath: prefixPath ?? undefined,
          steamcmdPath: steamcmdPath ?? "",
          baseDir: baseDir ?? "",
          backupDir: backupDir ?? "",
          scheduleType: schedule.schedule_type,
          enabled: true,
          configJson: schedule.config_json ?? "{}",
          nextRunMs,
        });
      }
    }

    // ── Global auto-update-check entry ─────────────────────────────────────
    // This is a synthetic entry (not in the schedules table) that fires the
    // shared cache update on the interval configured in Settings.
    const [autoCheckHours, lastChecked] = await Promise.all([
      getAppSetting("asa_auto_check_hours"),
      getAppSetting("asa_last_checked"),
    ]);
    const hours = parseInt(autoCheckHours ?? "0");
    if (hours > 0 && steamcmdPath && baseDir) {
      const intervalMs = hours * 3_600_000;
      let nextRunMs: number;
      if (!lastChecked) {
        // Never checked — wait 5 minutes after startup to let things settle.
        nextRunMs = Date.now() + 5 * 60_000;
      } else {
        const scheduled = new Date(lastChecked).getTime() + intervalMs;
        // If overdue, give a 30-second startup buffer before firing.
        nextRunMs = scheduled < Date.now() ? Date.now() + 30_000 : scheduled;
      }

      entries.push({
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
        configJson:   "{}",
        nextRunMs,
      });
    }

    await tauriCmd.syncSchedules(entries);
  } catch {
    // Non-fatal: scheduler will simply have no entries until next sync.
  }
}
