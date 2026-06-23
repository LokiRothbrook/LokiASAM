/**
 * server-utils.ts — shared helpers for server start/stop operations.
 *
 * Extracted from ServerCard and OverviewTab so StartupQueueManager and any
 * other callers can build start params without duplicating the logic.
 */

import { getServerConfig, getServerMods, getAppSetting, getCluster } from "@/lib/db";
import { ARK_MAPS, ARK_EVENTS, LAUNCH_PARAMETERS } from "@/data/game-data";
import type { StartServerParams } from "@/lib/tauri-commands";
import type { ServerRow } from "@/lib/db";

export const isLinux =
  typeof navigator !== "undefined" && !navigator.userAgent.includes("Windows");

export async function buildStartParams(server: ServerRow): Promise<StartServerParams> {
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

  const map = ARK_MAPS.find((m) => m.id === server.map_id);
  const enabledModIds = mods.filter((m) => m.enabled === 1).map((m) => m.mod_id);

  // Inject the active event flag and its mod ID
  if (server.active_event) {
    extraArgs.push(`-ActiveEvent=${server.active_event}`);
    const evt = ARK_EVENTS.find((e) => e.id === server.active_event);
    if (evt && !enabledModIds.includes(evt.modId)) {
      enabledModIds.push(evt.modId);
    }
  }

  // Inject cluster directory when this server belongs to a cluster
  if (server.cluster_id) {
    const cluster = await getCluster(server.cluster_id).catch(() => null);
    if (cluster) {
      const baseDir = await getAppSetting("base_dir").catch(() => null);
      const sep = isLinux ? "/" : "\\";
      const clusterDir = cluster.cluster_dir_override
        ?? `${baseDir}${sep}clusters${sep}${cluster.id}`;
      extraArgs.push(`-ClusterDirOverride=${clusterDir}`);
      extraArgs.push(`-clusterid=${cluster.id}`);
    }
  }

  const params: StartServerParams = {
    serverId:     server.id,
    serverName:   server.name,
    installPath:  server.install_path,
    mapPath:      map?.mapPath ?? "TheIsland_WP",
    port:         server.port,
    queryPort:    server.query_port,
    rconPort:     server.rcon_port,
    rconPassword: server.rcon_password,
    extraArgs,
    modIds:       enabledModIds,
  };

  if (isLinux) {
    params.protonPath  = (await getAppSetting("proton_path"))         ?? undefined;
    params.prefixPath  = (await getAppSetting("proton_prefix_path"))  ?? undefined;
  }

  return params;
}

/**
 * Build a human-readable preview of the full launch command for display.
 * Does NOT start the server. Fetches mods + cluster from DB.
 */
export async function buildLaunchCommandPreview(
  server: ServerRow,
  launchArgs: Record<string, string>,
): Promise<string> {
  const mods = await getServerMods(server.id).catch(() => []);
  const map = ARK_MAPS.find((m) => m.id === server.map_id);
  const mapPath = map?.mapPath ?? "TheIsland_WP";

  const extraArgs: string[] = Object.entries(launchArgs).flatMap(([k, v]) => {
    if (!v || v === "false" || v === "0") return [];
    const param = LAUNCH_PARAMETERS.find((p) => p.key === k);
    if (param?.type === "boolean") return v === "true" ? [param.flag] : [];
    if (param) return v ? [`${param.flag}${v}`] : [];
    if (k.startsWith("_")) return []; // internal keys
    return v === "true" ? [`-${k}`] : [`-${k}=${v}`];
  });


  if (server.active_event) {
    extraArgs.push(`-ActiveEvent=${server.active_event}`);
  }

  if (server.cluster_id) {
    const cluster = await getCluster(server.cluster_id).catch(() => null);
    if (cluster) {
      const baseDir = await getAppSetting("base_dir").catch(() => null);
      const sep = isLinux ? "/" : "\\";
      const clusterDir = cluster.cluster_dir_override ?? `${baseDir}${sep}clusters${sep}${cluster.id}`;
      extraArgs.push(`-ClusterDirOverride=${clusterDir}`);
      extraArgs.push(`-clusterid=${cluster.id}`);
    }
  }

  const enabledModIds = mods.filter((m) => m.enabled === 1).map((m) => m.mod_id);
  if (server.active_event) {
    const evt = ARK_EVENTS.find((e) => e.id === server.active_event);
    if (evt && !enabledModIds.includes(evt.modId)) enabledModIds.push(evt.modId);
  }

  const exe = isLinux ? "./ShooterGameServer" : "ShooterGameServer.exe";
  const modsArg = enabledModIds.length > 0 ? `-mods=${enabledModIds.join(",")}` : "";
  const portArgs = `-port=${server.port} -queryport=${server.query_port} -RCONPort=${server.rcon_port} -MaxPlayers=${server.max_players}`;
  const altSave = server.save_folder_name ? `?AltSaveDirectoryName=${server.save_folder_name}` : "";

  const parts = [
    `${exe} ${mapPath}?listen?Port=${server.port}?QueryPort=${server.query_port}${altSave}`,
    "-server -log",
    ...extraArgs,
    modsArg,
  ].filter(Boolean);

  return parts.join(" \\\n  ");
}
