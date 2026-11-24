/**
 * server-utils.ts — shared helpers for server start/stop operations.
 *
 * Extracted from ServerCard and OverviewTab so StartupQueueManager and any
 * other callers can build start params without duplicating the logic.
 */

import { getServerConfig, getServerMods, getAppSetting, getCluster, updateServerStatus, getServers } from "@/lib/db";
import { ARK_EVENTS, LAUNCH_PARAMETERS } from "@/data/game-data";
import { ensureMapsCacheLoaded, findMapById } from "@/lib/maps";
import { tauriCmd } from "@/lib/tauri-commands";
import type { QueryClient } from "@tanstack/react-query";
import type { StartServerParams } from "@/lib/tauri-commands";
import type { ServerRow } from "@/lib/db";

/**
 * Read the server list from the shared `["servers"]` React Query cache
 * (the same one `useServers()` keeps warm and every mutation in the app
 * invalidates), falling back to a real DB fetch only if it isn't populated
 * yet. Several always-mounted managers (RCON, log watcher) each used to call
 * `getServers()` directly on every `server://any-change` event — a
 * redundant DB round-trip per listener per status change, when the data was
 * already sitting in the query cache from `useServers()`.
 */
export async function getServersCached(queryClient: QueryClient): Promise<ServerRow[]> {
  const cached = queryClient.getQueryData<ServerRow[]>(["servers"]);
  if (cached) return cached;
  return queryClient.fetchQuery({ queryKey: ["servers"], queryFn: getServers });
}

export const isLinux =
  typeof navigator !== "undefined" && !navigator.userAgent.includes("Windows");

/**
 * Convert the per-server `launch_args_json` record into CLI argv tokens.
 * Shared by every place that turns saved launch-arg settings into a real
 * argv (starting a server, scheduled restarts/updates, the launch-command
 * preview) — this used to be reimplemented separately in three places, and
 * two of the three copies (here and scheduler-sync.ts) had no special case
 * for `_customCli`, so it fell through to the generic `-{key}={value}`
 * templating and was sent as one broken argv token containing an embedded
 * space instead of the user's actual flags.
 *
 * `_customCli` is free-text (not a real LAUNCH_PARAMETERS entry) — its value
 * is split on whitespace and pushed as separate argv tokens verbatim.
 */
export function launchArgsToExtraArgs(launchArgs: Record<string, string>): string[] {
  return Object.entries(launchArgs).flatMap(([k, v]) => {
    if (!v || v === "false" || v === "0") return [];
    if (k === "_customCli") return v.split(/\s+/).filter(Boolean);
    const param = LAUNCH_PARAMETERS.find((p) => p.key === k);
    if (param?.type === "boolean") return v === "true" ? [param.flag] : [];
    if (param) return v ? [`${param.flag}${v}`] : [];
    if (k.startsWith("_")) return []; // other internal keys, not real CLI flags
    return v === "true" ? [`-${k}`] : [`-${k}=${v}`];
  });
}

/**
 * Launch args the app derives from server state rather than from the saved
 * launch-arg settings: cluster membership and max players. (The active event
 * is turned on by its mod in -mods — see launchModIds; ASA has no working
 * -ActiveEvent flag.)
 * Shared by the real start params and the launch-command preview so the two
 * can't drift apart.
 */
async function derivedLaunchArgs(server: ServerRow): Promise<string[]> {
  const args: string[] = [];

  // Cluster members share a cluster dir/ID and are isolated from servers
  // outside the cluster (NoTransferFromFiltering) — always both together.
  if (server.cluster_id) {
    const cluster = await getCluster(server.cluster_id).catch(() => null);
    if (cluster) {
      // ASA appends "clusters/<ClusterID>" to -ClusterDirOverride itself, so
      // pass the cluster ROOT: the base dir (data lands in
      // {base}/clusters/{id}, the folder create_cluster makes) or the user's
      // custom dir. Passing {base}/clusters/{id} here nested the data one
      // level deeper ({base}/clusters/{id}/clusters/{id}).
      const baseDir = await getAppSetting("base_dir").catch(() => null);
      const clusterRoot = cluster.cluster_dir_override?.trim() || baseDir;
      args.push(`-ClusterDirOverride=${clusterRoot}`);
      args.push(`-clusterid=${cluster.id}`);
      args.push("-NoTransferFromFiltering");
    }
  }

  // ASA's player cap comes from the command line; MaxPlayers in
  // GameUserSettings.ini alone isn't reliably honored. Kept in sync with the
  // INI value by the Server Identity card / config save.
  if (server.max_players > 0) args.push(`-WinLiveMaxPlayers=${server.max_players}`);

  return args;
}

/** Enabled mod IDs plus the active event's mod — loading that mod is what enables the event in ASA. */
function launchModIds(server: ServerRow, mods: { mod_id: string; enabled: number }[]): string[] {
  const ids = mods.filter((m) => m.enabled === 1).map((m) => m.mod_id);
  if (server.active_event) {
    const evt = ARK_EVENTS.find((e) => e.id === server.active_event);
    if (evt && !ids.includes(evt.modId)) ids.push(evt.modId);
  }
  return ids;
}

export async function buildStartParams(server: ServerRow): Promise<StartServerParams> {
  const [config, mods] = await Promise.all([
    getServerConfig(server.id),
    getServerMods(server.id),
    ensureMapsCacheLoaded(),
  ]);

  const launchArgs: Record<string, string> = config
    ? JSON.parse(config.launch_args_json)
    : {};

  const extraArgs = [...launchArgsToExtraArgs(launchArgs), ...await derivedLaunchArgs(server)];

  const map = findMapById(server.map_id);
  const enabledModIds = launchModIds(server, mods);

  const params: StartServerParams = {
    serverId:     server.id,
    serverName:   server.name,
    installPath:  server.install_path,
    mapPath:      map?.mapPath ?? "TheIsland_WP",
    port:         server.port,
    queryPort:    server.query_port,
    rconPort:     server.rcon_port,
    rconPassword: server.admin_password,
    extraArgs,
    modIds:       enabledModIds,
    hideWindow:   server.hide_window === 1,
  };

  if (isLinux) {
    params.protonPath  = (await getAppSetting("proton_path"))         ?? undefined;
    params.prefixPath  = (await getAppSetting("proton_prefix_path"))  ?? undefined;
  }

  return params;
}

/**
 * Restart a single running server: builds start params, then either runs the
 * warn-players countdown (`start_graceful_restart`) or stops it directly and
 * hands off to the staggered startup queue (`restart_server`), depending on
 * the server's own `restart_warn_players` setting.
 *
 * Shared by the per-server Restart button and the dashboard's Restart All
 * bulk action so the two can't drift out of sync with each other.
 *
 * On failure of the non-warn path, reverts the server's status to "error" —
 * the warn path leaves status alone since Rust already reverts it to
 * "running" itself if the countdown gets cancelled.
 */
export async function restartServerGracefully(
  server: ServerRow,
  opts: { onInvalidate: () => void },
): Promise<void> {
  // Visible transition immediately — otherwise the card sits on "running"
  // with no feedback until the countdown/restart actually completes.
  await updateServerStatus(server.id, "stopping", server.pid);
  opts.onInvalidate();

  const startParams = await buildStartParams(server);

  if (server.restart_warn_players) {
    await tauriCmd.startGracefulRestart({
      serverId:      server.id,
      warnSeconds:   (server.restart_warn_minutes ?? 5) * 60,
      rconPort:      server.rcon_port,
      rconPassword:  server.admin_password,
      message:       server.restart_message || "Server restarting in {time}.",
      cancelMessage: server.restart_cancel_message || "Restart has been canceled.",
      startParams,
    });
    return;
  }

  try {
    // Stops the server then hands off to the staggered startup queue — the
    // "startup_queued" → "starting" → "running" transitions arrive via the
    // usual server://any-change events.
    await tauriCmd.restartServer(startParams, true);
  } catch (err) {
    await updateServerStatus(server.id, "error", null).catch(() => {});
    opts.onInvalidate();
    throw err;
  }
}

/**
 * Stop a single running server gracefully (SaveWorld + doexit via RCON, with
 * an optional in-game warning countdown first) — shared by the per-server
 * Stop button and the dashboard's Stop All bulk action so the two can't
 * drift out of sync with each other (mirrors `restartServerGracefully`).
 */
export async function stopServerGracefully(
  server: ServerRow,
  opts: { onInvalidate: () => void },
): Promise<void> {
  await updateServerStatus(server.id, "stopping", server.pid);
  opts.onInvalidate();
  await tauriCmd.gracefulStopServer(
    server.id,
    server.rcon_port,
    server.admin_password,
    server.shutdown_warn_players !== 0,
    server.shutdown_warn_minutes ?? 5,
    server.shutdown_message || "Server will shut down in {time}.",
  );
}

/**
 * Build a human-readable preview of the full launch command for display.
 * Does NOT start the server. Fetches mods + cluster from DB.
 */
export async function buildLaunchCommandPreview(
  server: ServerRow,
  launchArgs: Record<string, string>,
): Promise<string> {
  const [mods] = await Promise.all([
    getServerMods(server.id).catch(() => []),
    ensureMapsCacheLoaded(),
  ]);
  const map = findMapById(server.map_id);
  const mapPath = map?.mapPath ?? "TheIsland_WP";

  const extraArgs = [...launchArgsToExtraArgs(launchArgs), ...await derivedLaunchArgs(server)];
  const enabledModIds = launchModIds(server, mods);

  // Mirrors inner_start_server_with_state in server.rs (Linux runs the same
  // Windows binary through Proton).
  const exe = "ArkAscendedServer.exe";
  const modsArg = enabledModIds.length > 0 ? `-mods=${enabledModIds.join(",")}` : "";

  const parts = [
    `${exe} ${mapPath}?listen?Port=${server.port}?QueryPort=${server.query_port}`,
    // Hidden servers also get -unattended (see server.rs — never wait on a dialog).
    server.hide_window === 1 ? "-server -log -unattended" : "-server -log",
    modsArg,
    ...extraArgs,
  ].filter(Boolean);

  return parts.join(" \\\n  ");
}
