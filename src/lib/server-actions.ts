"use client";

import { tauriCmd } from "@/lib/tauri-commands";
import { getAppSetting, updateServerStatus, type ServerRow } from "@/lib/db";
import { dispatchNotification } from "@/lib/notifications";
import { NOTIFICATION_EVENTS } from "@/data/game-data";

/**
 * Re-copy the shared cache to a server's install directory via SteamCMD
 * (`update_server` — validates the cache, syncs files, preserves Saved/),
 * then relink SavedArks/ModsSaves. Shared by the failure-state Reinstall
 * button, the Maintenance tab, and the dashboard three-dot menu so all three
 * entry points run the exact same recovery sequence and leave the server in
 * the same state either way.
 *
 * Sets status to "installing" on start and "stopped"/"install_failed" on
 * completion; dispatches the install-complete/install-failed notifications.
 * Rethrows on failure so callers can show their own error UI.
 */
export async function reinstallServer(server: ServerRow): Promise<void> {
  const [baseDir, steamcmdPath] = await Promise.all([
    getAppSetting("base_dir"),
    getAppSetting("steamcmd_path"),
  ]);
  if (!baseDir || !steamcmdPath) {
    throw new Error("Base directory or SteamCMD path not configured");
  }
  const sep = baseDir.includes("\\") ? "\\" : "/";
  const cacheDir = `${baseDir.replace(/[/\\]$/, "")}${sep}lokiasam${sep}cache${sep}asa-server`;

  await updateServerStatus(server.id, "installing", null);

  try {
    await tauriCmd.updateServer(server.id, server.install_path, cacheDir, steamcmdPath);

    const { ensureMapsCacheLoaded, findMapById } = await import("@/lib/maps");
    await ensureMapsCacheLoaded().catch(() => {});
    const mapPath = findMapById(server.map_id)?.mapPath ?? "TheIsland_WP";

    await tauriCmd.createSaveLink(server.install_path, server.id, baseDir).catch((e) => {
      console.warn("createSaveLink failed after reinstall:", e);
    });
    await tauriCmd.createModsSavesLink(server.install_path, server.id, baseDir, mapPath).catch((e) => {
      console.warn("createModsSavesLink failed after reinstall:", e);
    });

    await updateServerStatus(server.id, "stopped", null);
    await dispatchNotification({
      eventType:  NOTIFICATION_EVENTS.SERVER_INSTALL_COMPLETE,
      serverId:   server.id,
      serverName: server.name,
      title:      `${server.name} installed successfully`,
      body:       "Server files are ready. You can start the server now.",
      severity:   "success",
    });
  } catch (err) {
    await updateServerStatus(server.id, "install_failed", null).catch(() => {});
    await dispatchNotification({
      eventType:  NOTIFICATION_EVENTS.SERVER_INSTALL_FAILED,
      serverId:   server.id,
      serverName: server.name,
      title:      `${server.name} install failed`,
      body:       "The server installation was canceled or failed.",
      severity:   "error",
    });
    throw err;
  }
}
