/**
 * notifications.ts — shared notification dispatch helper.
 *
 * Call `dispatchNotification(...)` from anywhere to:
 *  1. Fire an in-app toast (transient popup) if the In-App column is ticked.
 *  2. Log the event to `in_app_notifications` in SQLite.
 *     - If the Bell column is ticked for this event, log as unread (bumps the
 *       badge and shows in the bell popup).
 *     - Otherwise, log as pre-read (archived — still visible on the
 *       Notifications page but never clutters the bell).
 *  3. Fire OS desktop, Discord webhook, and/or email based on notification_configs.
 */

import { toast, type ExternalToast } from "sonner";
import { useAppStore } from "@/store/useAppStore";
import { logNotification, getNotificationConfigs } from "@/lib/db";
import { tauriCmd } from "@/lib/tauri-commands";
import { QUIET_NOTIFICATION_EVENTS, type NotificationEventType } from "@/data/game-data";

export interface DispatchNotificationParams {
  eventType: NotificationEventType;
  serverId: string | null;
  serverName: string;
  title: string;
  body: string;
  severity: "info" | "success" | "warning" | "error";
  /** Extra sonner options for the toast (id, duration, action, …). */
  toastOptions?: ExternalToast;
}

function showToast(
  severity: DispatchNotificationParams["severity"],
  title: string,
  body: string,
  extra?: ExternalToast,
) {
  const opts: ExternalToast = { ...extra, ...(body ? { description: body } : {}) };
  switch (severity) {
    case "success": toast.success(title, opts); break;
    case "warning": toast.warning(title, opts); break;
    case "error":   toast.error(title, opts); break;
    default:        toast.info(title, opts); break;
  }
}

/**
 * Prefix the title with the server name when it's about a server and the
 * name isn't already in the text — so a toast or log entry like "Failed to
 * fetch player list" says which server it came from.
 */
function withServerName(params: DispatchNotificationParams): string {
  const name = params.serverName.trim();
  if (!params.serverId || !name) return params.title;
  if (params.title.includes(name) || params.body.includes(name)) return params.title;
  return `${name}: ${params.title}`;
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

/**
 * Returns true if the event is ticked for the given channel config row. The
 * row lists exactly the events it's on for — an empty list means none
 * (migration 025 rewrote legacy "[]" rows, which meant "all", into explicit
 * lists). Unparseable JSON falls back to on rather than silencing.
 */
function eventEnabled(eventsJson: string, eventType: string): boolean {
  try {
    return (JSON.parse(eventsJson || "[]") as string[]).includes(eventType);
  } catch {
    return true;
  }
}

export async function dispatchNotification(
  input: DispatchNotificationParams
): Promise<void> {
  const params = { ...input, title: withServerName(input) };
  // ── 1. Load channel configs first so we can gate the toast ─────────────────
  let configs;
  try {
    configs = await getNotificationConfigs(params.serverId);
  } catch (err) {
    console.error("[notifications] Failed to load notification configs:", err);
    // Fall back to firing the toast so nothing is silently swallowed (the DB
    // isn't open yet during first-run setup, so there's nowhere to log it).
    showToast(params.severity, params.title, params.body, params.toastOptions);
    return;
  }

  // server-specific rows come first; per-server takes precedence over global
  const seen = new Set<string>();
  // Defaults if no config row exists yet: toast always; bell for everything
  // except routine confirmations / input hints.
  let inAppEnabled = true;
  let bellEnabled = !QUIET_NOTIFICATION_EVENTS.includes(params.eventType);

  for (const config of configs) {
    const channel = config.channel;
    if (seen.has(channel)) continue;
    if (config.server_id !== null) seen.add(channel);

    if (channel === "in_app") {
      inAppEnabled = config.enabled === 1 && eventEnabled(config.events_json, params.eventType);
      continue;
    }

    if (channel === "bell") {
      bellEnabled = config.enabled === 1 && eventEnabled(config.events_json, params.eventType);
      continue;
    }

    if (!config.enabled) continue;
    if (!eventEnabled(config.events_json, params.eventType)) continue;

    const cfg = JSON.parse(config.config_json || "{}") as Record<string, string | boolean | number>;

    if (channel === "desktop") {
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
    showToast(params.severity, params.title, params.body, params.toastOptions);
  }

  // ── 3. Log to DB ────────────────────────────────────────────────────────────
  // Every notification is archived (Notifications page). It shows as unread in
  // the bell exactly when the Bell column is ticked for this event —
  // independent of the toast/desktop columns.
  const showUnread = bellEnabled;

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
