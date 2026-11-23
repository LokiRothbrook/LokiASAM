/**
 * cluster-utils.ts — the one way to create, join and leave clusters, shared
 * by the creation wizard and the Clusters pages.
 *
 * Membership is just servers.cluster_id: the cluster launch args
 * (-clusterid, -ClusterDirOverride, -NoTransferFromFiltering) are derived from
 * it at launch time (see derivedLaunchArgs in server-utils.ts), so joining or
 * leaving takes effect on the server's next start.
 */

import { createClusterRecord, getAppSetting, setServerCluster } from "@/lib/db";
import { tauriCmd } from "@/lib/tauri-commands";

/** Create the cluster's shared data folder and its DB record. Returns the new cluster ID. */
export async function createCluster(name: string, customDir?: string | null): Promise<string> {
  const baseDir = (await getAppSetting("base_dir")) ?? "";
  const dir = customDir?.trim() || undefined;
  const id = await tauriCmd.createCluster(name.trim(), baseDir, dir);
  await createClusterRecord(id, name.trim(), dir ?? null);
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
