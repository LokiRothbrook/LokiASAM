/**
 * update-utils.ts — shared helpers for per-server update detection and application.
 *
 * Called after every global update check (both manual and auto) to compare
 * each server's installed build ID against the shared cache. Updates the
 * update_available column in the DB and optionally fires notifications.
 */

import {
  getServers, getServer, getAppSetting, setServerUpdateAvailable, setServerInstalledBuild, setAppSetting,
  updateServerStatus, type ServerRow,
} from "@/lib/db";
import { tauriCmd } from "@/lib/tauri-commands";
import { dispatchNotification } from "@/lib/notifications";
import { NOTIFICATION_EVENTS } from "@/data/game-data";
import { useAppStore } from "@/store/useAppStore";
import { syncSchedulesToRust } from "@/lib/scheduler-sync";
import { notify } from "@/lib/notify";
import { toast } from "sonner";
import { buildStartParams } from "@/lib/server-utils";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ServerUpdateInfo {
  id: string;
  name: string;
  status: string;
  installedBuild: string;
  cachedBuild: string;
  /** True if this server's Auto-Update automation is set to "When Found" — it
   *  will apply automatically within seconds, so manual-update UI should not
   *  offer to double it up. */
  autoUpdateImmediate: boolean;
  /** What the server's Auto-Update automation will do about it. */
  autoUpdatePlan: AutoUpdatePlan;
}

export type AutoUpdatePlan =
  | { kind: "now" }
  | { kind: "at_time"; time: string }
  | { kind: "manual" };

/** How (and whether) `server`'s Auto-Update automation will apply a pending update. */
export function getAutoUpdatePlan(server: Pick<ServerRow, "update_automation_json">): AutoUpdatePlan {
  try {
    const cfg = JSON.parse(server.update_automation_json || "{}");
    if (cfg.mode === "immediately") return { kind: "now" };
    if (cfg.mode === "at_time") return { kind: "at_time", time: cfg.update_time || "03:00" };
  } catch { /* malformed — treat as off */ }
  return { kind: "manual" };
}

/** Multi-line summary of what will happen to each outdated server, e.g. for
 *  the background check's notification — so it's clear whether anything is
 *  actually going to apply the update or it's waiting on the user. */
export function describeUpdatePlans(updates: ServerUpdateInfo[]): string {
  const now    = updates.filter((u) => u.autoUpdatePlan.kind === "now").map((u) => u.name);
  const manual = updates.filter((u) => u.autoUpdatePlan.kind === "manual").map((u) => u.name);
  const timed  = new Map<string, string[]>();
  for (const u of updates) {
    if (u.autoUpdatePlan.kind !== "at_time") continue;
    timed.set(u.autoUpdatePlan.time, [...(timed.get(u.autoUpdatePlan.time) ?? []), u.name]);
  }
  const lines: string[] = [];
  if (now.length > 0) lines.push(`Auto-updating now: ${now.join(", ")}.`);
  for (const [time, names] of timed) lines.push(`Auto-update scheduled for ${time}: ${names.join(", ")}.`);
  if (manual.length > 0) {
    lines.push(`Auto-Update is off for ${manual.join(", ")} — use Update All on the dashboard to apply.`);
  }
  return lines.join("\n");
}

export interface UpdateCheckSummary {
  /** Server IDs that were newly flagged (weren't flagged before this check). */
  newlyAvailable: string[];
  /** All servers currently having an update available (newly + previously flagged). */
  allWithUpdates: ServerUpdateInfo[];
}

/** True if `server`'s Auto-Update automation is set to "When Found" mode —
 *  it'll be picked up by the Rust scheduler within seconds of being flagged,
 *  so manual-update affordances should treat it as already spoken for. */
export function isAutoUpdateImmediate(server: Pick<ServerRow, "update_automation_json">): boolean {
  try {
    const cfg = JSON.parse(server.update_automation_json || "{}");
    return cfg.mode === "immediately";
  } catch {
    return false;
  }
}

// ── ASA cache update (shared across dashboard, settings, scheduler) ───────────

/**
 * Run a full ASA cache update/check via SteamCMD.  Sets the global
 * `asaCacheOpLabel` in Zustand so the TopBar spinner shows the right label.
 *
 * @param topBarLabel - Label shown in TopBar during the op (defaults to "Checking ASA updates…")
 * Returns the new build ID string, or null on error.
 */
export async function runAsaCacheUpdate(
  topBarLabel = "Checking ASA updates…"
): Promise<string | null> {
  const { setAsaCacheOpLabel } = useAppStore.getState();
  setAsaCacheOpLabel(topBarLabel);
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
    setAsaCacheOpLabel(null);
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
            id:                  server.id,
            name:                server.name,
            status:              server.status,
            installedBuild:      installed,
            cachedBuild:         cachedBuildId,
            autoUpdateImmediate: isAutoUpdateImmediate(server),
            autoUpdatePlan:      getAutoUpdatePlan(server),
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
            id:                  server.id,
            name:                server.name,
            status:              server.status,
            installedBuild:      "unknown",
            cachedBuild:         cachedBuildId,
            autoUpdateImmediate: isAutoUpdateImmediate(server),
            autoUpdatePlan:      getAutoUpdatePlan(server),
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

    const intro = names.length === 1
      ? `An update is available for ${names[0]}.`
      : `Updates available for: ${names.join(", ")}.`;
    const body = `${intro}\n${describeUpdatePlans(allWithUpdates.filter((s) => newlyAvailable.includes(s.id)))}`;

    await dispatchNotification({
      eventType:  NOTIFICATION_EVENTS.UPDATE_AVAILABLE,
      serverId:   null,
      serverName: "ASA Servers",
      title,
      body,
      severity:   "info",
    });
  }

  // Re-push schedules to Rust so any per-server Auto-Update automation
  // ("When Found" / "Daily at Time") picks up servers just flagged above —
  // those entries are synthesized from update_available in syncSchedulesToRust
  // and are otherwise never regenerated until the next unrelated schedule
  // fires or the app restarts, which left automation never actually applying.
  await syncSchedulesToRust();

  return { newlyAvailable, allWithUpdates };
}

// ── Single-server update apply ────────────────────────────────────────────────

/** In-game warning to broadcast (if enabled) before a stop triggered by an update. */
export interface UpdateShutdownWarn {
  warnPlayers: boolean;
  warnMinutes: number;
  warnMessage: string;
}

/**
 * Apply the cached update to a single server:
 *   1. Stop the server if it is running — always via graceful_stop_server, which
 *      always issues SaveWorld + doexit over RCON first (same safe-shutdown path
 *      the Stop button uses), and additionally broadcasts a countdown warning to
 *      players when `shutdownWarn.warnPlayers` is set. This never force-kills.
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
  rconPort: number,
  rconPassword: string,
  shutdownWarn: UpdateShutdownWarn,
  onStatusChange?: (msg: string) => void,
): Promise<void> {
  const [cacheBase, steamcmdPath] = await Promise.all([
    getAppSetting("base_dir"),
    getAppSetting("steamcmd_path"),
  ]);
  if (!cacheBase || !steamcmdPath) {
    const msg = "Base directory or SteamCMD not configured.";
    await dispatchNotification({
      eventType:  NOTIFICATION_EVENTS.UPDATE_FAILED,
      serverId,
      serverName,
      title:      "Server Update Failed",
      body:       `Failed to update ${serverName}: ${msg}`,
      severity:   "error",
    });
    throw new Error(msg);
  }

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
      await tauriCmd.gracefulStopServer(
        serverId, rconPort, rconPassword,
        shutdownWarn.warnPlayers, shutdownWarn.warnMinutes, shutdownWarn.warnMessage,
      ).catch((e) => {
        // The stop queues behind any backup/restart already running on this
        // server — if that operation stopped it in the meantime, there's
        // simply nothing left to stop.
        if (!String(e).includes("is not running")) throw e;
      });
    }

    onStatusChange?.("Applying update…");
    await tauriCmd.applyCacheToServer(serverId, installPath, cacheDir);

    await setServerUpdateAvailable(serverId, false);
    // Drop any stale per-server auto-update entry the Rust scheduler is still
    // holding (e.g. a "Daily at Time" fire scheduled for tonight) now that this
    // server no longer needs it — otherwise it fires anyway at the scheduled
    // time, needlessly stopping/restarting an already-up-to-date server.
    await syncSchedulesToRust();

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

// ── Apply updates to every outdated server ────────────────────────────────────

/**
 * Apply the cached update to every server in `targets` (typically every
 * server with `update_available === 1`), sequentially. Writes the correct
 * status transition at each step (update_queued → updating → running/stopped,
 * or startup_queued when a restart is needed) and calls `onInvalidate` after
 * every write so callers never show stale state — this is the single shared
 * implementation for both the Dashboard's "Update All" and Settings' "Apply
 * Update to All Servers", which previously reimplemented this independently
 * with diverging correctness (only one of the two kept the DB status column
 * in sync).
 */
export async function applyUpdateToAllServers(
  targets: ServerRow[],
  restartAfterUpdate: boolean,
  opts: {
    enqueueStartup: (ids: string[]) => void;
    onInvalidate: () => void;
    /** Per-server progress text, e.g. for a toast keyed by server id. */
    onProgress?: (serverId: string, msg: string) => void;
  },
): Promise<{ succeeded: number; failed: number }> {
  let succeeded = 0;
  let failed = 0;

  // Everything after the first target starts as queued so the UI can show
  // it's pending while the first one is actively updating.
  const rest = targets.slice(1);
  if (rest.length > 0) {
    await Promise.all(rest.map((s) => updateServerStatus(s.id, "update_queued", null)));
    opts.onInvalidate();
  }

  for (let i = 0; i < targets.length; i++) {
    const server = targets[i];

    // Re-check live status right before acting — a server's own Cancel
    // button (while it's sitting in "update_queued") just writes status back
    // to "stopped", and without this check this loop would reach it anyway
    // moments later and update it regardless, silently overriding the
    // cancel. Mirrors the same guard StartupQueueManager uses for the
    // startup queue. Only applies to i > 0 — the first target never passes
    // through "update_queued" (it starts updating immediately above), so
    // there's no queued state for a cancel to have reverted it from.
    if (i > 0) {
      const current = await getServer(server.id);
      if (!current || current.status !== "update_queued") continue;
    }

    await updateServerStatus(server.id, "updating", null);
    opts.onInvalidate();

    const wasRunning = server.status === "running" || server.status === "starting";

    try {
      await applyUpdateToServer(
        server.id,
        server.name,
        server.install_path,
        wasRunning,
        restartAfterUpdate,
        server.rcon_port,
        server.admin_password,
        {
          warnPlayers: server.update_warn_players !== 0,
          warnMinutes: server.update_warn_minutes ?? 5,
          warnMessage: server.update_message || "Server going down for update in {time}.",
        },
        (msg) => opts.onProgress?.(server.id, msg),
      );
      succeeded += 1;
    } catch (err) {
      if (err && typeof err === "object" && "restartNeeded" in err) {
        await updateServerStatus(server.id, "startup_queued", null);
        opts.onInvalidate();
        opts.enqueueStartup([server.id]);
        succeeded += 1;
        continue;
      }
      failed += 1;
      // applyUpdateToServer already sent the "Server Update Failed" notification.
      await updateServerStatus(server.id, "stopped", null).catch(() => {});
      opts.onInvalidate();
      continue;
    }

    await updateServerStatus(server.id, "stopped", null).catch(() => {});
    opts.onInvalidate();
  }

  if (succeeded > 0) {
    await dispatchNotification({
      eventType:  NOTIFICATION_EVENTS.SERVER_UPDATED,
      serverId:   null,
      serverName: "All Servers",
      title:      `${succeeded} Server${succeeded !== 1 ? "s" : ""} Updated`,
      body:       `${succeeded} server${succeeded !== 1 ? "s have" : " has"} been updated from the cache.`,
      severity:   "success",
    });
  }

  return { succeeded, failed };
}

/**
 * The per-server "Apply Update" button action, shared by the dashboard
 * ServerCard and the server OverviewTab so the two can't drift apart.
 *
 * Warn-enabled + running: hands off to Rust's graceful update (in-game
 * countdown, then SaveWorld/doexit, cache→server sync, optional restart).
 * Otherwise: applies the update directly (still a clean RCON shutdown).
 */
export async function runServerUpdateAction(
  server: ServerRow,
  opts: {
    isRunning: boolean;
    restartAfter: boolean;
    onInvalidate: () => void;
    /** Toggled around the direct (non-countdown) path, which is worth a spinner. */
    onPendingChange: (pending: boolean) => void;
    /** Called when the update finished but the server still needs starting. */
    onRestartNeeded: () => Promise<void>;
  },
): Promise<void> {
  const { isRunning, restartAfter, onInvalidate, onPendingChange, onRestartNeeded } = opts;

  if (server.update_warn_players && isRunning) {
    const [baseDir, steamcmdPath] = await Promise.all([
      getAppSetting("base_dir"),
      getAppSetting("steamcmd_path"),
    ]);
    if (!baseDir || !steamcmdPath) return;
    const sep = baseDir.includes("\\") ? "\\" : "/";
    const cacheDir = `${baseDir.replace(/[/\\]$/, "")}${sep}lokiasam${sep}cache${sep}asa-server`;
    const startParams = restartAfter ? await buildStartParams(server) : null;

    // Show a visible transition immediately — otherwise the server sits on
    // "running" with no feedback until the warning countdown finishes.
    // Rust reverts this back to "running" if the countdown gets cancelled.
    await updateServerStatus(server.id, "stopping", server.pid);
    onInvalidate();

    tauriCmd.startGracefulUpdate({
      serverId:      server.id,
      serverName:    server.name,
      warnSeconds:   (server.update_warn_minutes ?? 5) * 60,
      rconPort:      server.rcon_port,
      rconPassword:  server.admin_password,
      message:       server.update_message || "Server going down for update in {time}.",
      cancelMessage: server.update_cancel_message || "Update has been canceled.",
      installPath:   server.install_path,
      cacheDir,
      steamcmdPath,
      restartAfter,
      startParams,
    }).catch(async (err) => {
      // Refused before anything happened (e.g. a backup is running) —
      // undo the optimistic "stopping" so the server doesn't look stuck.
      await updateServerStatus(server.id, server.status, server.pid);
      onInvalidate();
      notify.error(`Update of ${server.name} couldn't start`, { description: err, server, event: "update_failed" });
    });
    return;
  }

  onPendingChange(true);
  try {
    try {
      await applyUpdateToServer(
        server.id,
        server.name,
        server.install_path,
        isRunning,
        restartAfter,
        server.rcon_port,
        server.admin_password,
        {
          // Only reached when the warn countdown path above wasn't taken
          // (warn disabled, or server not running) — still always saves the
          // world and shuts down cleanly via RCON either way.
          warnPlayers: false,
          warnMinutes: server.update_warn_minutes ?? 5,
          warnMessage: server.update_message || "Server going down for update in {time}.",
        },
        // Progress steps update one toast in place — not logged.
        (msg) => toast.info(msg, { id: `update-${server.id}` }),
      );
    } catch (err) {
      if (err && typeof err === "object" && "restartNeeded" in err) {
        await onRestartNeeded();
        return;
      }
      throw err;
    }
    onInvalidate();
    // Success and failure were already notified by applyUpdateToServer.
  } catch {
    /* reported by applyUpdateToServer */
  } finally {
    toast.dismiss(`update-${server.id}`);
    onPendingChange(false);
    onInvalidate();
  }
}
