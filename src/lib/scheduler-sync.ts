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
import { ARK_MAPS } from "@/data/game-data";
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
      const extraArgs = Object.entries(launchArgs)
        .filter(([, v]) => v === "true" || v === "1")
        .map(([k]) => `-${k}`);

      const modIds = mods.filter((m) => m.enabled === 1).map((m) => m.mod_id);

      const map = ARK_MAPS.find((m) => m.id === server.map_id);
      const mapPath = map?.mapPath ?? "TheIsland_WP";

      for (const schedule of enabled) {
        // Compute next_run_ms from either the stored ISO date or fresh from cron.
        let nextRunMs: number;
        if (schedule.next_run) {
          const stored = new Date(schedule.next_run).getTime();
          nextRunMs = isNaN(stored) ? Date.now() : stored;
        } else {
          const next = getNextCronDate(schedule.cron_expression);
          nextRunMs = next ? next.getTime() : Date.now();
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

    await tauriCmd.syncSchedules(entries);
  } catch {
    // Non-fatal: scheduler will simply have no entries until next sync.
  }
}
