/**
 * notifications.ts — shared notification dispatch helper.
 *
 * Call `dispatchNotification(...)` from anywhere to:
 *  1. Always fire an in-app toast (transient popup, severity-colored).
 *  2. Log the event to `in_app_notifications` in SQLite.
 *     - If the `bell` channel config includes this event type, log as unread
 *       (bumps the badge and shows in the bell popup).
 *     - Otherwise, log as pre-read (silently archived — still visible on the
 *       notifications page but never clutters the bell).
 *  3. Fire OS desktop, Discord webhook, and/or email based on notification_configs.
 */

import { toast } from "sonner";
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
    default:        return 0x00ffff;
  }
}

/** Returns true if the event is enabled for the given channel config row. */
function eventEnabled(eventsJson: string, eventType: string): boolean {
  const events: string[] = JSON.parse(eventsJson || "[]");
  return events.length === 0 || events.includes(eventType);
}

export async function dispatchNotification(
  params: DispatchNotificationParams
): Promise<void> {
  // ── 1. Load channel configs first so we can gate the toast ─────────────────
  let configs;
  try {
    configs = await getNotificationConfigs(params.serverId);
  } catch (err) {
    console.error("[notifications] Failed to load notification configs:", err);
    // Fall back to firing the toast so failures are never silently swallowed.
    toast.error(params.title, { description: params.body });
    return;
  }

  // server-specific rows come first; per-server takes precedence over global
  const seen = new Set<string>();
  // Defaults: show toast and bell if no config row exists yet.
  let inAppEnabled = true;
  let desktopEnabled = false; // will be set by config loop
  let bellEnabled = true;

  for (const config of configs) {
    const channel = config.channel;
    if (seen.has(channel)) continue;
    if (config.server_id !== null) seen.add(channel);

    if (channel === "in_app") {
      inAppEnabled = config.enabled === 1 && eventEnabled(config.events_json, params.eventType);
      continue;
    }

    if (channel === "bell") {
      // Bell badge only bumps when bell is enabled AND in-app or desktop is on —
      // if the user silenced both visible channels, treat it as already read.
      bellEnabled = config.enabled === 1 && eventEnabled(config.events_json, params.eventType);
      continue;
    }

    if (!config.enabled) continue;
    if (!eventEnabled(config.events_json, params.eventType)) continue;

    const cfg = JSON.parse(config.config_json || "{}") as Record<string, string | boolean | number>;

    if (channel === "desktop") {
      desktopEnabled = true;
      tauriCmd
        .sendOsNotification(params.title, params.body)
        .catch((err) => { console.error("[notifications] OS notification failed:", err); });
    } else if (channel === "discord") {
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
    } else if (channel === "email") {
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

  // ── 2. Fire in-app toast if in_app channel is enabled ─────────────────────
  if (inAppEnabled) {
    switch (params.severity) {
      case "success": toast.success(params.title, { description: params.body }); break;
      case "warning": toast.warning(params.title, { description: params.body }); break;
      case "error":   toast.error(params.title,   { description: params.body }); break;
      default:        toast.info(params.title,    { description: params.body }); break;
    }
  }

  // ── 3. Log to DB ────────────────────────────────────────────────────────────
  // Bell shows as unread only when bell is enabled AND at least one visible
  // channel (in_app or desktop) is also on. If the user silenced all visible
  // channels the notification is still archived but marked already-read so the
  // badge doesn't bump.
  const visibleChannelActive = inAppEnabled || desktopEnabled;
  const showUnread = bellEnabled && visibleChannelActive;

  const id = crypto.randomUUID();
  try {
    await logNotification({
      id,
      serverId:  params.serverId,
      eventType: params.eventType,
      title:     params.title,
      body:      params.body,
      severity:  params.severity,
      read:      showUnread ? 0 : 1,
    });
    if (showUnread) {
      useAppStore.getState().incrementUnread();
    }
  } catch (err) {
    console.error("[notifications] Failed to log notification:", err);
  }
}
