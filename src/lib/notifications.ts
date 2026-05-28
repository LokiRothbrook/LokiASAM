/**
 * notifications.ts — shared notification dispatch helper.
 *
 * Call `dispatchNotification(...)` from anywhere (components, hooks, managers)
 * to:
 *  1. Persist the event to `in_app_notifications` in SQLite.
 *  2. Bump the unread counter in Zustand so the bell icon updates instantly.
 *  3. Fire all configured output channels (in_app_toast, desktop, discord, email)
 *     from notification_configs rows.
 *
 * All external channel calls are fire-and-forget — failures are logged but never
 * block the caller.
 *
 * Legacy fallback: if no `desktop` notification_configs row exists the old
 * app_settings keys (desktop_notifications_enabled + notify_*) are used so
 * existing users are not silently downgraded before they visit the settings matrix.
 */

import { toast } from "sonner";
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

const LEGACY_DESKTOP_SETTING: Partial<Record<NotificationEventType, { key: string; defaultOn: boolean }>> = {
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
    default:        return 0x00ffff;
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

  // ── 3. Output channels from notification_configs ─────────────────────────────
  let configs;
  try {
    configs = await getNotificationConfigs(params.serverId);
  } catch (err) {
    console.error("[notifications] Failed to load notification configs:", err);
    return;
  }

  // server-specific rows are returned first; per-server takes precedence over global
  const seen = new Set<string>();
  let handledDesktop = false;

  for (const config of configs) {
    const key = config.channel;
    if (seen.has(key)) continue;
    if (config.server_id !== null) seen.add(key);

    if (key === "desktop") handledDesktop = true;

    if (!config.enabled) continue;

    const events: string[] = JSON.parse(config.events_json || "[]");
    if (events.length > 0 && !events.includes(params.eventType)) continue;

    const cfg = JSON.parse(config.config_json || "{}") as Record<string, string | boolean | number>;

    if (key === "in_app_toast") {
      switch (params.severity) {
        case "success": toast.success(params.title, { description: params.body }); break;
        case "warning": toast.warning(params.title, { description: params.body }); break;
        case "error":   toast.error(params.title,   { description: params.body }); break;
        default:        toast.info(params.title,    { description: params.body }); break;
      }
    } else if (key === "desktop") {
      tauriCmd
        .sendOsNotification(params.title, params.body)
        .catch((err) => { console.error("[notifications] OS notification failed:", err); });
    } else if (key === "discord") {
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
    } else if (key === "email") {
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

  // ── 4. Legacy desktop fallback (no notification_configs 'desktop' row yet) ───
  if (!handledDesktop) {
    try {
      const masterEnabled = await getAppSetting("desktop_notifications_enabled");
      if (masterEnabled !== "false") {
        const eventSetting = LEGACY_DESKTOP_SETTING[params.eventType];
        let eventAllowed = true;
        if (eventSetting) {
          const stored = await getAppSetting(eventSetting.key);
          eventAllowed = stored !== null ? stored !== "false" : eventSetting.defaultOn;
        }
        if (eventAllowed) {
          tauriCmd
            .sendOsNotification(params.title, params.body)
            .catch((err) => { console.error("[notifications] OS notification (legacy) failed:", err); });
        }
      }
    } catch (err) {
      console.error("[notifications] Failed to read legacy desktop settings:", err);
    }
  }
}
