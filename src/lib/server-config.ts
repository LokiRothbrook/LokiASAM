/**
 * server-config.ts — the one path for loading and saving a server's INI
 * configuration, shared by the Config tab, the Server Identity card and INI
 * snapshot restore.
 *
 * The DB copy (server_config) is what the app edits; the INI files on disk
 * are what the game reads. Saving writes both, snapshots the files first,
 * and keeps the servers row's identity columns (name, ports, passwords, max
 * players) in sync with the matching INI keys.
 */

import {
  getServerConfig, saveServerConfig, getAppSetting, updateServerIdentity,
  isServerNameTaken, type ServerRow, type ServerIdentity,
} from "@/lib/db";
import { tauriCmd, type ServerConfigJson } from "@/lib/tauri-commands";
import {
  type IniSections, GAME_SESSION_SECTION, getIni, deleteIni, mergeIniSections,
} from "@/lib/ini-utils";

const isEmpty = (s: IniSections | undefined) => !s || Object.keys(s).length === 0;

/**
 * Load the config the app should show for a server. Falls back to the INI
 * files on disk when the DB copy has no INI content (imported servers start
 * that way) and stores what it read, so a later save can't replace the real
 * files with an empty editor's contents.
 */
export async function loadEffectiveConfig(
  server: Pick<ServerRow, "id" | "install_path">,
): Promise<{ config: ServerConfigJson; fromDisk: boolean }> {
  const row = await getServerConfig(server.id);
  const config: ServerConfigJson = {
    gameUserSettings: JSON.parse(row?.game_user_settings_json || "{}"),
    gameIni: JSON.parse(row?.game_ini_json || "{}"),
    launchArgs: JSON.parse(row?.launch_args_json || "{}"),
  };
  if (!isEmpty(config.gameUserSettings) || !isEmpty(config.gameIni)) {
    return { config, fromDisk: false };
  }

  const disk = await tauriCmd.readServerConfig(server.install_path).catch(() => null);
  if (!disk || (isEmpty(disk.gameUserSettings) && isEmpty(disk.gameIni))) {
    return { config, fromDisk: false };
  }
  const merged: ServerConfigJson = {
    gameUserSettings: disk.gameUserSettings,
    gameIni: disk.gameIni,
    launchArgs: config.launchArgs,
  };
  await saveServerConfig(
    server.id,
    JSON.stringify(merged.gameUserSettings),
    JSON.stringify(merged.gameIni),
    JSON.stringify(merged.launchArgs ?? {}),
  );
  return { config: merged, fromDisk: true };
}

/** Write the identity values into a GameUserSettings section map. */
export function applyIdentityToGus(gus: IniSections, identity: ServerIdentity): IniSections {
  let out = mergeIniSections(gus, {
    SessionSettings: { SessionName: identity.name },
    ServerSettings: {
      ServerPassword: identity.serverPassword ?? "",
      ServerAdminPassword: identity.adminPassword,
      RCONPort: String(identity.rconPort),
    },
    [GAME_SESSION_SECTION]: { MaxPlayers: String(identity.maxPlayers) },
  });
  // ServerPassword belongs in [ServerSettings]; drop any legacy copy.
  out = deleteIni(out, "SessionSettings", "ServerPassword");
  return out;
}

/** The identity a server row would have if it matched this config's INI keys. */
function identityFromGus(server: ServerRow, gus: IniSections): ServerIdentity {
  const num = (v: string | undefined, fallback: number) => {
    const n = parseInt(v ?? "", 10);
    return isNaN(n) || n <= 0 ? fallback : n;
  };
  return {
    name:           getIni(gus, "SessionSettings", "SessionName")?.trim() || server.name,
    port:           server.port,
    queryPort:      server.query_port,
    rconPort:       num(getIni(gus, "ServerSettings", "RCONPort"), server.rcon_port),
    maxPlayers:     num(getIni(gus, GAME_SESSION_SECTION, "MaxPlayers"), server.max_players),
    serverPassword: getIni(gus, "ServerSettings", "ServerPassword") ?? server.server_password,
    adminPassword:  getIni(gus, "ServerSettings", "ServerAdminPassword")?.trim() || server.admin_password,
  };
}

export interface SaveConfigResult {
  /** Non-fatal problems the caller should surface (e.g. snapshot failed). */
  warnings: string[];
}

/**
 * Save a server's config: snapshot the current INI files, write the new ones,
 * store the DB copy, then sync the servers row with the identity INI keys.
 */
export async function saveServerConfigFull(server: ServerRow, cfg: ServerConfigJson): Promise<SaveConfigResult> {
  const warnings: string[] = [];

  // Snapshot BEFORE writing, so the snapshot holds the pre-save state and the
  // save can be rolled back from Config History.
  const backupDir = await getAppSetting("backup_dir").catch(() => null);
  if (backupDir) {
    await tauriCmd.createIniBackup(server.id, server.install_path, backupDir).catch((e) => {
      // "No INI files found" just means a first save — nothing to snapshot.
      if (!String(e).includes("No INI files")) warnings.push(`Config snapshot skipped: ${e}`);
    });
  }

  await tauriCmd.writeServerConfig(server.install_path, cfg);

  try {
    await saveServerConfig(
      server.id,
      JSON.stringify(cfg.gameUserSettings),
      JSON.stringify(cfg.gameIni),
      JSON.stringify(cfg.launchArgs ?? {}),
    );
  } catch (dbErr) {
    // The disk write can't be made atomic with this DB write. The file IS
    // already updated; retrying is safe and fixes the DB copy.
    throw new Error(
      `Config was written to disk, but saving it to the app database failed: ${dbErr}. ` +
      `Click Save again — your disk changes are already applied and will not be lost by retrying.`
    );
  }

  warnings.push(...await syncIdentityFromGus(server, cfg.gameUserSettings));

  return { warnings };
}

/**
 * Bring the servers row's identity columns in line with the identity INI keys.
 * Returns warnings (e.g. the INI's SessionName is taken by another server).
 */
async function syncIdentityFromGus(server: ServerRow, gus: IniSections): Promise<string[]> {
  const warnings: string[] = [];
  const next = identityFromGus(server, gus);
  if (next.name !== server.name && await isServerNameTaken(next.name)) {
    warnings.push(`Another server is already named "${next.name}" — the app keeps showing "${server.name}".`);
    next.name = server.name;
  }
  const changed =
    next.name !== server.name ||
    next.rconPort !== server.rcon_port ||
    next.maxPlayers !== server.max_players ||
    (next.serverPassword ?? "") !== (server.server_password ?? "") ||
    next.adminPassword !== server.admin_password;
  if (changed) {
    await updateServerIdentity(server.id, next);
    // RCON auth/port changed — reconnect with the new values right away
    // instead of waiting for the next failed command.
    if (next.adminPassword !== server.admin_password || next.rconPort !== server.rcon_port) {
      tauriCmd.rconDisconnect(server.id).catch(() => {});
    }
  }

  return warnings;
}

/**
 * Restore an INI snapshot folder over the server's config files.
 * Snapshots the current files first so the restore itself can be undone,
 * then adopts the restored files as the app's config copy (keeping launch
 * args, which aren't stored in INI files) — otherwise the Config tab would
 * keep showing the old DB copy and the next Save would undo the restore.
 */
export async function restoreIniSnapshot(server: ServerRow, snapshotName: string): Promise<SaveConfigResult> {
  const warnings: string[] = [];
  const backupDir = await getAppSetting("backup_dir");
  if (!backupDir) throw new Error("Backup directory is not configured.");
  const sep = backupDir.includes("\\") ? "\\" : "/";
  const base = `${backupDir}${sep}${server.id}${sep}ini`;

  let source = snapshotName;
  const undo = await tauriCmd.createIniBackup(server.id, server.install_path, backupDir)
    .then(() => true)
    .catch((e) => { warnings.push(`Undo snapshot skipped: ${e}`); return false; });
  // Taking the undo snapshot archives the previous "current" folder under a
  // timestamp — it's now the newest archived snapshot.
  if (undo && snapshotName === "current") {
    const list = await tauriCmd.listIniBackups(server.id, backupDir);
    const archived = list.find((n) => n !== "current");
    if (!archived) throw new Error("Snapshot moved during restore — reopen Config History and try again.");
    source = archived;
  }
  await tauriCmd.restoreIniBackup(server.id, `${base}${sep}${source}`, server.install_path);

  const disk = await tauriCmd.readServerConfig(server.install_path);
  const row = await getServerConfig(server.id);
  await saveServerConfig(
    server.id,
    JSON.stringify(disk.gameUserSettings),
    JSON.stringify(disk.gameIni),
    row?.launch_args_json || "{}",
  );
  warnings.push(...await syncIdentityFromGus(server, disk.gameUserSettings));
  return { warnings };
}
