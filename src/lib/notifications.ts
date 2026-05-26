/**
 * notifications.ts — shared notification dispatch helper.
 *
 * Call `dispatchNotification(...)` from anywhere (components, hooks, managers)
 * to:
 *  1. Persist the event to `in_app_notifications` in SQLite.
 *  2. Bump the unread counter in Zustand so the bell icon updates instantly.
 *  3. Fire any configured external channels (OS toast, Discord webhook, email)
 *     for this server based on `notification_configs` rows.
 *
 * All external channel calls are fire-and-forget — failures are silently dropped
 * so a broken webhook never blocks the caller.
 */

import { useAppStore } from "@/store/useAppStore";
import { logNotification, getNotificationConfigs } from "@/lib/db";
import { tauriCmd } from "@/lib/tauri-commands";
import type { NotificationEventType } from "@/data/game-data";

export interface DispatchNotificationParams {
  eventType: NotificationEventType;
  serverId: string | null;
  serverName: string;
  title: string;
  body: string;
  severity: "info" | "success" | "warning" | "error";
}

/** Severity → Discord embed color integer. */
function severityColor(severity: DispatchNotificationParams["severity"]): number {
  switch (severity) {
    case "success": return 0x00ff88;
    case "warning": return 0xffaa00;
    case "error":   return 0xff0055;
    default:        return 0x00ffff; // info → cyan
  }
}

export async function dispatchNotification(
  params: DispatchNotificationParams
): Promise<void> {
  const id = crypto.randomUUID();

  // ── 1. Always log in-app ────────────────────────────────────────────────────
  try {
    await logNotification({
      id,
      serverId:  params.serverId,
      eventType: params.eventType,
      title:     params.title,
      body:      params.body,
      severity:  params.severity,
    });
  } catch {
    // DB errors must not prevent the caller from proceeding.
    return;
  }

  // ── 2. Bump Zustand unread counter ──────────────────────────────────────────
  useAppStore.getState().incrementUnread();

  // ── 3. Fire external channels based on notification_configs ─────────────────
  let configs;
  try {
    configs = await getNotificationConfigs(params.serverId);
  } catch {
    return;
  }

  // If both a server-specific row and a global (server_id IS NULL) row exist for
  // the same channel, the server-specific row takes precedence.
  const seen = new Set<string>();
  for (const config of configs) {
    // server-specific rows are returned first by the SQL ORDER BY server_id NULLS LAST
    const key = config.channel;
    if (seen.has(key)) continue;
    if (config.server_id !== null) seen.add(key); // mark only per-server rows

    if (!config.enabled) continue;

    const events: string[] = JSON.parse(config.events_json || "[]");
    if (events.length > 0 && !events.includes(params.eventType)) continue;

    const cfg = JSON.parse(config.config_json || "{}") as Record<string, string | boolean | number>;

    if (config.channel === "desktop") {
      tauriCmd
        .sendOsNotification(params.title, params.body)
        .catch(() => {});
    } else if (config.channel === "discord") {
      const url = cfg.webhookUrl as string | undefined;
      if (url) {
        tauriCmd
          .sendDiscordNotification(url, {
            title:       params.title,
            description: params.body,
            color:       severityColor(params.severity),
            serverName:  params.serverName,
            eventType:   params.eventType,
          })
          .catch(() => {});
      }
    } else if (config.channel === "email") {
      const host       = cfg.host       as string | undefined;
      const toAddress  = cfg.toAddress  as string | undefined;
      if (host && toAddress) {
        tauriCmd
          .sendEmailNotification(
            {
              host,
              port:        Number(cfg.port ?? 587),
              username:    (cfg.username  as string) ?? "",
              password:    (cfg.password  as string) ?? "",
              fromAddress: (cfg.fromAddress as string) ?? "noreply@lokiasam",
              toAddress,
              useTls:      Boolean(cfg.useTls ?? false),
            },
            { subject: params.title, body: params.body }
          )
          .catch(() => {});
      }
    }
  }
}
