/**
 * clone-utils.ts — copy a server's automation onto a newly created server
 * (used when cloning / copying from an existing server in the wizard).
 */

import {
  getServer, getServerSchedules, createSchedule, updateScheduleConfig,
  updateServerShutdownSettings, updateServerRestartSettings, updateServerUpdateSettings,
  setServerUpdateAutomation, updateServerMemoryLimit, updateBackupBroadcastMessage, setServerAutoStart,
  getAppSetting, setAppSetting, type UpdateAutomation,
} from "@/lib/db";
import { getNextCronDate } from "@/components/shared/CronBuilder";

/**
 * Copy schedules, warning settings, auto-update automation, auto-start,
 * memory limit, backup broadcast message and backup retention from
 * `sourceId` to `targetId`.
 */
export async function copyServerAutomation(sourceId: string, targetId: string): Promise<void> {
  const source = await getServer(sourceId);
  if (!source) throw new Error("Source server not found");

  for (const sch of await getServerSchedules(sourceId)) {
    const id = crypto.randomUUID();
    await createSchedule({
      id,
      serverId: targetId,
      scheduleType: sch.schedule_type,
      cronExpression: sch.cron_expression,
      enabled: sch.enabled === 1,
      configJson: sch.config_json ?? "{}",
    });
    const nextIso = getNextCronDate(sch.cron_expression)?.toISOString() ?? new Date().toISOString();
    await updateScheduleConfig(id, sch.cron_expression, sch.config_json ?? "{}", nextIso);
  }

  await updateServerShutdownSettings(
    targetId, source.shutdown_warn_players !== 0, source.shutdown_warn_minutes ?? 5,
    source.shutdown_message || "Server will shut down in {time}.",
  );
  await updateServerRestartSettings(
    targetId, source.restart_warn_players !== 0, source.restart_warn_minutes ?? 5,
    source.restart_message || "Server restarting in {time}.",
    source.restart_cancel_message || "Restart has been canceled.",
  );
  await updateServerUpdateSettings(
    targetId, source.update_warn_players !== 0, source.update_warn_minutes ?? 5,
    source.update_message || "Server going down for update in {time}.",
    source.update_cancel_message || "Update has been canceled.",
  );

  try {
    const automation = JSON.parse(source.update_automation_json || "{}") as UpdateAutomation;
    if (Object.keys(automation).length > 0) await setServerUpdateAutomation(targetId, automation);
  } catch { /* malformed — leave the default */ }

  await updateServerMemoryLimit(targetId, source.memory_limit_gb);
  if (source.auto_start === 1) await setServerAutoStart(targetId, true);
  if (source.backup_broadcast_message) await updateBackupBroadcastMessage(targetId, source.backup_broadcast_message);

  for (const key of ["login_backup_keep", "manual_backup_keep"]) {
    const v = await getAppSetting(`${key}_${sourceId}`);
    if (v !== null) await setAppSetting(`${key}_${targetId}`, v);
  }
}
