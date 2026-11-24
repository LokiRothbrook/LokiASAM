/**
 * config-checks.ts — problems worth confirming before a config save.
 * Each entry is a plain sentence; an empty list means nothing to warn about.
 * The user can always choose to save anyway.
 */

import { getServers, type ServerRow } from "@/lib/db";
import { tauriCmd, type ServerConfigJson } from "@/lib/tauri-commands";
import { getIni, isIniTrue } from "@/lib/ini-utils";

/** Settings that only take effect alongside a launch flag. */
const COMPANION_FLAGS: { section: string; key: string; flag: string; active: (v: string) => boolean }[] = [
  { section: "ServerSettings", key: "KickIdlePlayersPeriod", flag: "EnableIdlePlayerKick", active: (v) => parseFloat(v) > 0 },
  { section: "ServerSettings", key: "AutoDestroyOldStructuresMultiplier", flag: "AutoDestroyStructures", active: (v) => parseFloat(v) > 0 },
  { section: "ServerSettings", key: "CustomDynamicConfigUrl", flag: "UseDynamicConfig", active: (v) => v.trim().length > 0 },
];

export async function checkConfigBeforeSave(server: ServerRow, cfg: ServerConfigJson): Promise<string[]> {
  const issues: string[] = [];
  const gus = cfg.gameUserSettings;
  const args = cfg.launchArgs ?? {};
  const flagOn = (k: string) => args[k] === "true";

  const rconEnabled = getIni(gus, "ServerSettings", "RCONEnabled");
  if (rconEnabled !== undefined && !isIniTrue(rconEnabled)) {
    issues.push(
      "RCON is disabled. The app uses RCON for the player list, chat, broadcasts, restart/update " +
      "warnings and graceful shutdowns — all of those will stop working.",
    );
  }

  const adminPw = getIni(gus, "ServerSettings", "ServerAdminPassword");
  if (adminPw !== undefined && !adminPw.trim()) {
    issues.push("The admin password is blank. RCON can't authenticate without it, and in-game admin access is disabled.");
  }

  const rconPort = parseInt(getIni(gus, "ServerSettings", "RCONPort") ?? "", 10);
  if (!isNaN(rconPort)) {
    if (rconPort === server.port || rconPort === server.query_port) {
      issues.push(`RCON port ${rconPort} is the same as this server's game or query port.`);
    } else {
      const others = (await getServers()).filter((s) => s.id !== server.id);
      const clash = others.find((s) => [s.port, s.query_port, s.rcon_port].includes(rconPort));
      if (clash) issues.push(`RCON port ${rconPort} is already used by "${clash.name}".`);
    }
  }

  for (const c of COMPANION_FLAGS) {
    const v = getIni(gus, c.section, c.key);
    if (v !== undefined && c.active(v) && !flagOn(c.flag)) {
      issues.push(`${c.key} is set but the -${c.flag} launch parameter is off, so it has no effect.`);
    }
  }

  if (flagOn("exclusivejoin")) {
    const list = await tauriCmd.readAccessList(server.install_path, "exclusive_join").catch(() => "");
    if (!list.split(/\r?\n/).some((l) => l.trim())) {
      issues.push("Exclusive join is on but the whitelist is empty — nobody will be able to join. Add players under Advanced → Admins & Whitelist.");
    }
  }

  return issues;
}
