/**
 * update-utils.ts — shared helpers for per-server update detection.
 *
 * Called after every global update check (both manual and auto) to compare
 * each server's installed build ID against the shared cache. Updates the
 * update_available column in the DB and fires notifications.
 */

import { getServers, getAppSetting, setServerUpdateAvailable } from "@/lib/db";
import { tauriCmd } from "@/lib/tauri-commands";
import { dispatchNotification } from "@/lib/notifications";
import { NOTIFICATION_EVENTS } from "@/data/game-data";

/**
 * Compare every server's installed build ID against the shared cache build ID.
 * Sets update_available = true for any server whose installed build is behind
 * the cache, false for any server that is current or not yet installed.
 *
 * Safe to call on every global check even if the cache itself didn't change —
 * a server that was manually updated since the last check will get its badge
 * cleared here.
 *
 * Returns the list of server IDs that newly have an update available.
 */
export async function runPerServerUpdateCheck(): Promise<string[]> {
  const cachedBuildId = await getAppSetting("asa_cached_build_id");
  if (!cachedBuildId) return [];

  const servers = await getServers();
  const newlyAvailable: string[] = [];

  await Promise.all(
    servers.map(async (server) => {
      try {
        const installed = await tauriCmd.getInstalledBuildId(server.install_path);
        const isOutdated = !!installed && installed !== cachedBuildId;
        const wasAlreadyFlagged = server.update_available === 1;

        await setServerUpdateAvailable(server.id, isOutdated);

        if (isOutdated && !wasAlreadyFlagged) {
          newlyAvailable.push(server.id);
          await dispatchNotification({
            eventType:  NOTIFICATION_EVENTS.UPDATE_AVAILABLE,
            serverId:   server.id,
            serverName: server.name,
            title:      "Server Update Available",
            body:       `${server.name} is behind the cache (installed: ${installed}, cache: ${cachedBuildId}).`,
            severity:   "info",
          });
        }
      } catch {
        // If we can't read this server's ACF (not yet installed, permissions,
        // etc.) leave its update_available flag as-is.
      }
    })
  );

  return newlyAvailable;
}

/**
 * Apply the cached update to a single server:
 *   1. Stop the server if it is running (records whether it was).
 *   2. Apply the shared cache to the server's install directory.
 *   3. Restart the server if it was running before.
 *   4. Clear the update_available flag.
 *
 * Fires UPDATE_STARTED, SERVER_UPDATED (or UPDATE_FAILED) notifications.
 */
export async function applyUpdateToServer(
  serverId: string,
  serverName: string,
  installPath: string,
  isRunning: boolean,
  onStatusChange?: (msg: string) => void,
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
    // Stop if running
    if (isRunning) {
      onStatusChange?.("Stopping server…");
      await tauriCmd.stopServer(serverId, false);
      // Brief pause so the process has time to exit
      await new Promise((r) => setTimeout(r, 3000));
    }

    // Apply cache → server
    onStatusChange?.("Applying update…");
    await tauriCmd.applyCacheToServer(serverId, installPath, cacheDir);

    // Clear badge
    await setServerUpdateAvailable(serverId, false);

    await dispatchNotification({
      eventType:  NOTIFICATION_EVENTS.SERVER_UPDATED,
      serverId,
      serverName,
      title:      "Server Updated",
      body:       `${serverName} has been updated successfully.`,
      severity:   "success",
    });

    // Restart if it was running
    if (isRunning) {
      onStatusChange?.("Restarting server…");
      // The caller is responsible for restarting via its existing start flow
      // (it has access to the full StartServerParams). Signal via thrown value.
      throw { restartNeeded: true };
    }
  } catch (err) {
    if (err && typeof err === "object" && "restartNeeded" in err) {
      throw err; // propagate restart signal, not an error
    }
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
