/**
 * cluster-utils.ts — the one way to create, join and leave clusters, shared
 * by the creation wizard and the Clusters pages.
 *
 * Membership is just servers.cluster_id: the cluster launch args
 * (-clusterid, -ClusterDirOverride, -NoTransferFromFiltering) are derived from
 * it at launch time (see derivedLaunchArgs in server-utils.ts), so joining or
 * leaving takes effect on the server's next start.
 */

import { createClusterRecord, getAppSetting, setServerCluster, type BackupTierSettings } from "@/lib/db";
import { tauriCmd } from "@/lib/tauri-commands";

/** Create the cluster's shared data folder and its DB record (with its backup schedule). Returns the new cluster ID. */
export async function createCluster(name: string, customDir?: string | null, backupTiers?: BackupTierSettings): Promise<string> {
  const baseDir = (await getAppSetting("base_dir")) ?? "";
  const dir = customDir?.trim() || undefined;
  const id = await tauriCmd.createCluster(name.trim(), baseDir, dir);
  await createClusterRecord(id, name.trim(), dir ?? null, backupTiers);
  return id;
}

export async function joinCluster(serverId: string, clusterId: string): Promise<void> {
  await tauriCmd.addServerToCluster(serverId, clusterId);
  await setServerCluster(serverId, clusterId);
}

export async function leaveCluster(serverId: string): Promise<void> {
  await tauriCmd.removeServerFromCluster(serverId);
  await setServerCluster(serverId, null);
}

/**
 * The folder a cluster's shared data actually lives in. ASA appends
 * `clusters/<id>` to -ClusterDirOverride, which the app sets to the custom
 * folder or the base folder (see derivedLaunchArgs in server-utils.ts).
 */
export function clusterDataDir(
  cluster: { id: string; cluster_dir_override: string | null },
  baseDir: string,
): string {
  const root = (cluster.cluster_dir_override?.trim() || baseDir).replace(/[/\\]$/, "");
  return `${root}/clusters/${cluster.id}`;
}
