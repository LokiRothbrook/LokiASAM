"use client";

/**
 * NotificationMatrix — per-event × per-channel notification toggle grid.
 *
 * Rows: all 14 notification event types
 * Columns: In-App Toast | Desktop | Discord | SMTP
 *
 * Reads and writes directly to notification_configs in SQLite. Migrates
 * legacy app_settings desktop toggles to notification_configs on first render
 * if no 'desktop' row exists yet.
 */

import { useState, useEffect, useCallback } from "react";
import { Loader2, Monitor, Bell, MessageSquare, Mail } from "lucide-react";
import {
  getGlobalChannelConfig,
  saveGlobalChannelEvents,
  getNotificationConfigs,
  getAppSetting,
  saveNotificationConfig,
} from "@/lib/db";
import { NOTIFICATION_EVENTS, NOTIFICATION_EVENT_LABELS } from "@/data/game-data";
import type { NotificationEventType } from "@/data/game-data";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ChannelId = "in_app_toast" | "desktop" | "discord" | "email";

interface ChannelDef {
  id: ChannelId;
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
  description: string;
}

const CHANNELS: ChannelDef[] = [
  { id: "in_app_toast", label: "In-App Toast",   Icon: Bell,         description: "Temporary popup toasts in the app window" },
  { id: "desktop",      label: "Desktop",         Icon: Monitor,      description: "OS system notifications" },
  { id: "discord",      label: "Discord",         Icon: MessageSquare, description: "Discord webhook" },
  { id: "email",        label: "SMTP",            Icon: Mail,         description: "Email via SMTP" },
];

// Default events enabled per channel (used when no config row exists yet)
const CHANNEL_DEFAULTS: Record<ChannelId, NotificationEventType[]> = {
  in_app_toast: Object.values(NOTIFICATION_EVENTS) as NotificationEventType[],
  desktop:      ["server_started", "server_crashed", "update_available"],
  discord:      Object.values(NOTIFICATION_EVENTS) as NotificationEventType[],
  email:        Object.values(NOTIFICATION_EVENTS) as NotificationEventType[],
};

// Events ordered for display
const ALL_EVENTS = Object.values(NOTIFICATION_EVENTS) as NotificationEventType[];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface NotificationMatrixProps {
  /** Called after any toggle is saved so parents can react if needed. */
  onSaved?: () => void;
}

export function NotificationMatrix({ onSaved }: NotificationMatrixProps) {
  // channelEvents[channel] = Set of enabled event types for that channel
  const [channelEvents, setChannelEvents] = useState<Record<ChannelId, Set<NotificationEventType>>>({
    in_app_toast: new Set(CHANNEL_DEFAULTS.in_app_toast),
    desktop:      new Set(CHANNEL_DEFAULTS.desktop),
    discord:      new Set(CHANNEL_DEFAULTS.discord),
    email:        new Set(CHANNEL_DEFAULTS.email),
  });

  // Whether Discord / SMTP credentials are configured (gates those columns)
  const [discordConfigured, setDiscordConfigured] = useState(false);
  const [emailConfigured, setEmailConfigured] = useState(false);
  const [loading, setLoading] = useState(true);

  // ── Load state from DB ─────────────────────────────────────────────────────
  const loadState = useCallback(async () => {
    setLoading(true);
    try {
      const globalConfigs = await getNotificationConfigs(null);

      const byChannel = Object.fromEntries(
        globalConfigs.map((c) => [c.channel, c])
      );

      const newChannelEvents = { ...channelEvents };

      for (const ch of ["in_app_toast", "desktop", "discord", "email"] as ChannelId[]) {
        const row = byChannel[ch];
        if (row) {
          const events: string[] = JSON.parse(row.events_json || "[]");
          // empty array means "all events"
          newChannelEvents[ch] = events.length === 0
            ? new Set(ALL_EVENTS)
            : new Set(events as NotificationEventType[]);
        } else if (ch === "desktop") {
          // Migrate legacy app_settings for desktop
          const [masterRaw, startRaw, crashRaw, stopRaw, updateRaw] = await Promise.all([
            getAppSetting("desktop_notifications_enabled"),
            getAppSetting("notify_server_start"),
            getAppSetting("notify_server_crash"),
            getAppSetting("notify_server_stop"),
            getAppSetting("notify_update_available"),
          ]);
          const masterEnabled = masterRaw !== "false";
          if (masterEnabled) {
            const legacyEvents: NotificationEventType[] = [];
            if (startRaw  !== "false") legacyEvents.push("server_started");
            if (crashRaw  !== "false") legacyEvents.push("server_crashed");
            if (stopRaw   === "true")  legacyEvents.push("server_stopped");
            if (updateRaw !== "false") legacyEvents.push("update_available");
            newChannelEvents.desktop = new Set(legacyEvents.length > 0 ? legacyEvents : CHANNEL_DEFAULTS.desktop);
          } else {
            newChannelEvents.desktop = new Set();
          }
          // Persist migration
          await saveNotificationConfig({
            id: crypto.randomUUID(),
            serverId: null,
            channel: "desktop",
            enabled: masterEnabled,
            configJson: "{}",
            eventsJson: JSON.stringify([...newChannelEvents.desktop]),
          });
        } else {
          newChannelEvents[ch] = new Set(CHANNEL_DEFAULTS[ch]);
        }
      }

      setChannelEvents(newChannelEvents);

      // Check if Discord / SMTP have credentials configured
      const discordRow = byChannel.discord;
      const emailRow   = byChannel.email;
      if (discordRow) {
        const cfg = JSON.parse(discordRow.config_json || "{}");
        setDiscordConfigured(!!cfg.webhookUrl);
      }
      if (emailRow) {
        const cfg = JSON.parse(emailRow.config_json || "{}");
        setEmailConfigured(!!cfg.host && !!cfg.toAddress);
      }
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { loadState(); }, [loadState]);

  // ── Toggle handler ─────────────────────────────────────────────────────────
  const handleToggle = useCallback(async (channel: ChannelId, event: NotificationEventType) => {
    const current = channelEvents[channel];
    const next = new Set(current);
    if (next.has(event)) {
      next.delete(event);
    } else {
      next.add(event);
    }
    setChannelEvents((prev) => ({ ...prev, [channel]: next }));
    saveGlobalChannelEvents(channel, [...next]).then(() => onSaved?.()).catch(console.error);
  }, [channelEvents, onSaved]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-6 text-sm" style={{ color: "var(--text-muted)" }}>
        <Loader2 className="w-4 h-4 animate-spin" />
        Loading notification settings…
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs border-collapse">
        <thead>
          <tr>
            <th className="text-left py-2 pr-4 font-medium" style={{ color: "var(--text-muted)", width: "40%" }}>
              Event
            </th>
            {CHANNELS.map((ch) => {
              const Icon = ch.Icon;
              const disabled = (ch.id === "discord" && !discordConfigured) || (ch.id === "email" && !emailConfigured);
              return (
                <th
                  key={ch.id}
                  className="text-center pb-2 px-2"
                  style={{ color: disabled ? "var(--text-subtle)" : "var(--text-primary)", width: "15%" }}
                >
                  <div className="flex flex-col items-center gap-1">
                    <Icon className="w-3.5 h-3.5" />
                    <span>{ch.label}</span>
                    {disabled && (
                      <span className="font-normal text-[9px]" style={{ color: "var(--text-subtle)" }}>
                        (not configured)
                      </span>
                    )}
                  </div>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {ALL_EVENTS.map((event, i) => (
            <tr
              key={event}
              style={{
                background: i % 2 === 0 ? "rgba(255,255,255,0.02)" : "transparent",
              }}
            >
              <td className="py-2.5 pr-4" style={{ color: "var(--text-primary)" }}>
                {NOTIFICATION_EVENT_LABELS[event]}
              </td>
              {CHANNELS.map((ch) => {
                const disabled =
                  (ch.id === "discord" && !discordConfigured) ||
                  (ch.id === "email"   && !emailConfigured);
                const checked = channelEvents[ch.id].has(event);
                return (
                  <td key={ch.id} className="text-center py-2.5 px-2">
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={disabled}
                      onChange={() => handleToggle(ch.id, event)}
                      className="w-3.5 h-3.5 cursor-pointer"
                      style={{
                        accentColor: "var(--neon-purple)",
                        opacity: disabled ? 0.3 : 1,
                        cursor: disabled ? "not-allowed" : "pointer",
                      }}
                      title={disabled ? "Configure credentials above to enable this channel" : undefined}
                    />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
