/**
 * server-utils.ts — shared helpers for server start/stop operations.
 *
 * Extracted from ServerCard and OverviewTab so StartupQueueManager and any
 * other callers can build start params without duplicating the logic.
 */

import { getServerConfig, getServerMods, getAppSetting } from "@/lib/db";
import { ARK_MAPS, LAUNCH_PARAMETERS } from "@/data/game-data";
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

  const params: StartServerParams = {
    serverId:   server.id,
    serverName: server.name,
    installPath: server.install_path,
    mapPath:    map?.mapPath ?? "TheIsland_WP",
    port:       server.port,
    queryPort:  server.query_port,
    rconPort:   server.rcon_port,
    extraArgs,
    modIds:     enabledModIds,
  };

  if (isLinux) {
    params.protonPath  = (await getAppSetting("proton_path"))         ?? undefined;
    params.prefixPath  = (await getAppSetting("proton_prefix_path"))  ?? undefined;
  }

  return params;
}
