/**
 * update-utils.ts — shared helpers for per-server update detection and application.
 *
 * Called after every global update check (both manual and auto) to compare
 * each server's installed build ID against the shared cache. Updates the
 * update_available column in the DB and optionally fires notifications.
 */

import { getServers, getAppSetting, setServerUpdateAvailable, setServerInstalledBuild, setAppSetting } from "@/lib/db";
import { tauriCmd } from "@/lib/tauri-commands";
import { dispatchNotification } from "@/lib/notifications";
import { NOTIFICATION_EVENTS } from "@/data/game-data";
import { useAppStore } from "@/store/useAppStore";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ServerUpdateInfo {
  id: string;
  name: string;
  status: string;
  installedBuild: string;
  cachedBuild: string;
}

export interface UpdateCheckSummary {
  /** Server IDs that were newly flagged (weren't flagged before this check). */
  newlyAvailable: string[];
  /** All servers currently having an update available (newly + previously flagged). */
  allWithUpdates: ServerUpdateInfo[];
}

// ── ASA cache update (shared across dashboard, settings, scheduler) ───────────

/**
 * Run a full ASA cache update/check via SteamCMD.  Sets the global
 * `asaCacheUpdateInProgress` flag in Zustand so the TopBar spinner shows.
 *
 * Returns the new build ID string, or null on error.
 */
export async function runAsaCacheUpdate(): Promise<string | null> {
  const { setAsaCacheUpdateInProgress } = useAppStore.getState();
  setAsaCacheUpdateInProgress(true);
  try {
    const [baseDir, steamcmdPath] = await Promise.all([
      getAppSetting("base_dir"),
      getAppSetting("steamcmd_path"),
    ]);
    if (!baseDir || !steamcmdPath) return null;
    const sep = baseDir.includes("\\") ? "\\" : "/";
    const cacheDir = `${baseDir.replace(/[/\\]$/, "")}${sep}lokiasam${sep}cache${sep}asa-server`;
    const newBuild = await tauriCmd.updateCache("check", cacheDir, steamcmdPath);
    const now = new Date().toISOString();
    await Promise.all([
      setAppSetting("asa_cached_build_id", newBuild),
      setAppSetting("asa_latest_build_id", newBuild),
      setAppSetting("asa_last_checked", now),
    ]);
    return newBuild;
  } finally {
    setAsaCacheUpdateInProgress(false);
  }
}

// ── Per-server update check ───────────────────────────────────────────────────

/**
 * Compare every server's installed build ID against the shared cache build ID.
 * Sets update_available = true for any server whose installed build is behind
 * the cache, false for any server that is current or not yet installed.
 *
 * When `silent = true` (manual check), suppresses the consolidated toast so the
 * caller can show a dialog instead. Notification center logging still occurs
 * for background checks (silent = false).
 *
 * Returns a summary of which servers have updates available.
 */
export async function runPerServerUpdateCheck(silent = false): Promise<UpdateCheckSummary> {
  const cachedBuildId = await getAppSetting("asa_cached_build_id");
  if (!cachedBuildId) return { newlyAvailable: [], allWithUpdates: [] };

  const servers = await getServers();
  const newlyAvailable: string[] = [];
  const allWithUpdates: ServerUpdateInfo[] = [];

  await Promise.all(
    servers.map(async (server) => {
      try {
        const installed = await tauriCmd.getInstalledBuildId(server.install_path);
        const isOutdated = !!installed && installed !== cachedBuildId;
        const wasAlreadyFlagged = server.update_available === 1;

        // Persist installed_build_id to DB for display (handles existing servers
        // that pre-date the build version cache feature)
        if (installed && server.installed_build_id !== installed) {
          await setServerInstalledBuild(server.id, installed).catch(() => null);
        }

        await setServerUpdateAvailable(server.id, isOutdated);

        if (isOutdated) {
          allWithUpdates.push({
            id:             server.id,
            name:           server.name,
            status:         server.status,
            installedBuild: installed,
            cachedBuild:    cachedBuildId,
          });
          if (!wasAlreadyFlagged) {
            newlyAvailable.push(server.id);
          }
        }
      } catch {
        // Can't read ACF (not yet installed, permissions, etc.) — leave flag as-is.
        // If it was already flagged, include it in the summary.
        if (server.update_available === 1) {
          allWithUpdates.push({
            id:             server.id,
            name:           server.name,
            status:         server.status,
            installedBuild: "unknown",
            cachedBuild:    cachedBuildId,
          });
        }
      }
    })
  );

  // Fire a single consolidated notification for background checks.
  // For manual checks (silent = true) the caller shows a dialog instead.
  if (!silent && newlyAvailable.length > 0) {
    const names = allWithUpdates
      .filter((s) => newlyAvailable.includes(s.id))
      .map((s) => s.name);

    const title = names.length === 1
      ? "Server Update Available"
      : `${names.length} Servers Need Updates`;

    const body = names.length === 1
      ? `An update is available for ${names[0]}.`
      : `Updates available for: ${names.join(", ")}.`;

    await dispatchNotification({
      eventType:  NOTIFICATION_EVENTS.UPDATE_AVAILABLE,
      serverId:   null,
      serverName: "ASA Servers",
      title,
      body,
      severity:   "info",
    });
  }

  return { newlyAvailable, allWithUpdates };
}

// ── Single-server update apply ────────────────────────────────────────────────

/**
 * Apply the cached update to a single server:
 *   1. Stop the server if it is running.
 *   2. Apply the shared cache to the server's install directory.
 *   3. Restart the server if it was running AND restartAfterUpdate is true.
 *   4. Clear the update_available flag.
 *
 * Fires UPDATE_STARTED, SERVER_UPDATED (or UPDATE_FAILED) notifications.
 * Throws `{ restartNeeded: true }` as a signal (not an error) when the caller
 * should restart the server using its own start flow (which has StartServerParams).
 */
export async function applyUpdateToServer(
  serverId: string,
  serverName: string,
  installPath: string,
  wasRunning: boolean,
  restartAfterUpdate: boolean,
  onStatusChange?: (msg: string) => void,
  rconPort?: number,
  rconPassword?: string,
): Promise<void> {
  const [cacheBase, steamcmdPath] = await Promise.all([
    getAppSetting("base_dir"),
    getAppSetting("steamcmd_path"),
  ]);
  if (!cacheBase || !steamcmdPath) throw new Error("Base directory or SteamCMD not configured.");

  const sep = cacheBase.includes("\\") ? "\\" : "/";
  const cacheDir = `${cacheBase.replace(/[/\\]$/, "")}${sep}lokiasam${sep}cache${sep}asa-server`;

  await dispatchNotification({
    eventType:  NOTIFICATION_EVENTS.UPDATE_STARTED,
    serverId,
    serverName,
    title:      "Server Update Started",
    body:       `Updating ${serverName}…`,
    severity:   "info",
  });

  try {
    if (wasRunning) {
      onStatusChange?.("Stopping server…");
      if (rconPort !== undefined && rconPassword !== undefined) {
        await tauriCmd.gracefulStopServer(serverId, rconPort, rconPassword, false, 0, "");
      } else {
        await tauriCmd.stopServer(serverId, false);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }

    onStatusChange?.("Applying update…");
    await tauriCmd.applyCacheToServer(serverId, installPath, cacheDir);

    await setServerUpdateAvailable(serverId, false);

    await dispatchNotification({
      eventType:  NOTIFICATION_EVENTS.SERVER_UPDATED,
      serverId,
      serverName,
      title:      "Server Updated",
      body:       `${serverName} has been updated successfully.`,
      severity:   "success",
    });

    if (wasRunning && restartAfterUpdate) {
      onStatusChange?.("Restarting server…");
      // Caller is responsible for restart (it has StartServerParams).
      throw { restartNeeded: true };
    }
  } catch (err) {
    if (err && typeof err === "object" && "restartNeeded" in err) throw err;

    await dispatchNotification({
      eventType:  NOTIFICATION_EVENTS.UPDATE_FAILED,
      serverId,
      serverName,
      title:      "Server Update Failed",
      body:       `Failed to update ${serverName}: ${err}`,
      severity:   "error",
    });
    throw err;
  }
}
