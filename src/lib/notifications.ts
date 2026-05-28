/**
 * notifications.ts — shared notification dispatch helper.
 *
 * Call `dispatchNotification(...)` from anywhere (components, hooks, managers)
 * to:
 *  1. Persist the event to `in_app_notifications` in SQLite.
 *  2. Bump the unread counter in Zustand so the bell icon updates instantly.
 *  3. Fire OS desktop notifications if enabled in app_settings.
 *  4. Fire any configured webhook channels (Discord, email) from notification_configs rows.
 *
 * All external channel calls are fire-and-forget — failures are logged but never
 * block the caller.
 */

import { useAppStore } from "@/store/useAppStore";
import { logNotification, getNotificationConfigs, getAppSetting } from "@/lib/db";
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

/**
 * Maps event types to their per-event app_settings key.
 * Events not listed here are allowed if desktop_notifications_enabled is true.
 * The default column matches the defaultOn value in NOTIFICATION_TOGGLES.
 */
const DESKTOP_EVENT_SETTING: Partial<Record<NotificationEventType, { key: string; defaultOn: boolean }>> = {
  server_started:   { key: "notify_server_start",     defaultOn: true  },
  server_crashed:   { key: "notify_server_crash",     defaultOn: true  },
  server_stopped:   { key: "notify_server_stop",      defaultOn: false },
  update_available: { key: "notify_update_available", defaultOn: true  },
};

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

  // ── 1. Log in-app (best-effort — DB failure must not block external channels) ─
  let dbOk = false;
  try {
    await logNotification({
      id,
      serverId:  params.serverId,
      eventType: params.eventType,
      title:     params.title,
      body:      params.body,
      severity:  params.severity,
    });
    dbOk = true;
  } catch (err) {
    console.error("[notifications] Failed to log notification:", err);
  }

  // ── 2. Bump Zustand unread counter (only if DB write succeeded) ──────────────
  if (dbOk) {
    useAppStore.getState().incrementUnread();
  }

  // ── 3. OS desktop notification — controlled by app_settings ─────────────────
  // Desktop notifications use a dedicated toggle in the Notification Events
  // settings section (desktop_notifications_enabled + per-event notify_* keys)
  // rather than the notification_configs table which is for webhook channels.
  try {
    const masterEnabled = await getAppSetting("desktop_notifications_enabled");
    if (masterEnabled !== "false") {
      const eventSetting = DESKTOP_EVENT_SETTING[params.eventType];
      let eventAllowed = true;
      if (eventSetting) {
        const stored = await getAppSetting(eventSetting.key);
        eventAllowed = stored !== null ? stored !== "false" : eventSetting.defaultOn;
      }
      if (eventAllowed) {
        tauriCmd
          .sendOsNotification(params.title, params.body)
          .catch((err) => { console.error("[notifications] OS notification failed:", err); });
      }
    }
  } catch (err) {
    console.error("[notifications] Failed to read desktop notification settings:", err);
  }

  // ── 4. Webhook channels (Discord, email) from notification_configs ───────────
  let configs;
  try {
    configs = await getNotificationConfigs(params.serverId);
  } catch (err) {
    console.error("[notifications] Failed to load notification configs:", err);
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

    if (config.channel === "discord") {
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
      const host      = cfg.host      as string | undefined;
      const toAddress = cfg.toAddress as string | undefined;
      if (host && toAddress) {
        tauriCmd
          .sendEmailNotification(
            {
              host,
              port:        Number(cfg.port ?? 587),
              username:    (cfg.username    as string) ?? "",
              password:    (cfg.password    as string) ?? "",
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
