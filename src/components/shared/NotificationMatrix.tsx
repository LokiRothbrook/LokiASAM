"use client";

/**
 * NotificationMatrix — per-event × per-channel notification toggle grid.
 *
 * Rows: all active notification event types (12 — player events excluded)
 * Columns: Bell | Desktop | Discord | SMTP
 *
 * Reads and writes directly to notification_configs (server_id IS NULL).
 * Bell column controls whether the event shows as unread in the bell badge
 * and popup. All events still always fire an in-app toast and get logged.
 * Discord and SMTP columns are disabled if credentials are not yet configured.
 */

import { useState, useEffect, useCallback, forwardRef, useImperativeHandle } from "react";
import { toast } from "sonner";
import { Loader2, AppWindow, Bell, Monitor, MessageSquare, Mail } from "lucide-react";
import {
  getNotificationConfigs,
  saveGlobalChannelEvents,
} from "@/lib/db";
import { NOTIFICATION_EVENTS, NOTIFICATION_EVENT_LABELS } from "@/data/game-data";
import type { NotificationEventType } from "@/data/game-data";

// ---------------------------------------------------------------------------
// Types & constants
// ---------------------------------------------------------------------------

type ChannelId = "in_app" | "bell" | "desktop" | "discord" | "email";

interface ChannelDef {
  id: ChannelId;
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
  description: string;
}

const CHANNELS: ChannelDef[] = [
  { id: "in_app",  label: "In-App",  Icon: AppWindow,     description: "Toast popup inside LokiASAM" },
  { id: "bell",    label: "Bell",    Icon: Bell,          description: "Show as unread in the bell badge and popup" },
  { id: "desktop", label: "Desktop", Icon: Monitor,       description: "OS system notification" },
  { id: "discord", label: "Discord", Icon: MessageSquare, description: "Discord webhook" },
  { id: "email",   label: "SMTP",    Icon: Mail,          description: "Email via SMTP" },
];

const ALL_EVENTS = Object.values(NOTIFICATION_EVENTS) as NotificationEventType[];

// Default events enabled per channel when no config row exists yet
const CHANNEL_DEFAULTS: Record<ChannelId, NotificationEventType[]> = {
  in_app:  ALL_EVENTS,
  bell:    ALL_EVENTS,
  desktop: [],
  discord: ALL_EVENTS,
  email:   ALL_EVENTS,
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface NotificationMatrixHandle {
  getChannelEvents: () => Record<string, string[]>;
}

interface NotificationMatrixProps {
  onSaved?: () => void;
  /** Called on every toggle with the full current channel→events map. When
   *  provided the component skips the direct DB write (useful in the wizard
   *  where the DB may not be initialised yet). */
  onChange?: (events: Record<string, string[]>) => void;
  /** Increment to force the component to re-query credential status from the
   *  DB (e.g. after credentials are saved on the same page). */
  refreshKey?: number;
}

export const NotificationMatrix = forwardRef<NotificationMatrixHandle, NotificationMatrixProps>(
function NotificationMatrix({ onSaved, onChange, refreshKey }, ref) {
  const [channelEvents, setChannelEvents] = useState<Record<ChannelId, Set<NotificationEventType>>>({
    in_app:  new Set(CHANNEL_DEFAULTS.in_app),
    bell:    new Set(CHANNEL_DEFAULTS.bell),
    desktop: new Set(CHANNEL_DEFAULTS.desktop),
    discord: new Set(CHANNEL_DEFAULTS.discord),
    email:   new Set(CHANNEL_DEFAULTS.email),
  });

  const [discordConfigured, setDiscordConfigured] = useState(false);
  const [emailConfigured, setEmailConfigured] = useState(false);
  const [loading, setLoading] = useState(true);

  const loadState = useCallback(async () => {
    setLoading(true);
    try {
      let globalConfigs: Awaited<ReturnType<typeof getNotificationConfigs>>;
      try {
        globalConfigs = await getNotificationConfigs(null);
      } catch (err) {
        if (String(err).includes("Database not initialized")) {
          // DB not yet created (first-run wizard) — use in-memory defaults
          setLoading(false);
          return;
        }
        throw err;
      }
      const byChannel = Object.fromEntries(globalConfigs.map((c) => [c.channel, c]));

      const next: Record<ChannelId, Set<NotificationEventType>> = {
        in_app:  new Set(CHANNEL_DEFAULTS.in_app),
        bell:    new Set(CHANNEL_DEFAULTS.bell),
        desktop: new Set(CHANNEL_DEFAULTS.desktop),
        discord: new Set(CHANNEL_DEFAULTS.discord),
        email:   new Set(CHANNEL_DEFAULTS.email),
      };
      for (const ch of ["in_app", "bell", "desktop", "discord", "email"] as ChannelId[]) {
        const row = byChannel[ch];
        if (row) {
          const events: string[] = JSON.parse(row.events_json || "[]");
          next[ch] = new Set(events as NotificationEventType[]);
        }
        // No row → keep the default already in next (CHANNEL_DEFAULTS)
      }
      setChannelEvents(next);

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
  }, []);

  useEffect(() => { loadState(); }, [loadState]);

  // Re-query credential status whenever the parent signals a credential change.
  useEffect(() => {
    if (refreshKey !== undefined && refreshKey > 0) loadState();
  }, [refreshKey, loadState]);

  useImperativeHandle(ref, () => ({
    getChannelEvents: () =>
      Object.fromEntries(
        Object.entries(channelEvents).map(([ch, set]) => [ch, [...set]])
      ),
  }), [channelEvents]);

  const handleToggle = useCallback(async (channel: ChannelId, event: NotificationEventType) => {
    const next = new Set(channelEvents[channel]);
    if (next.has(event)) {
      next.delete(event);
    } else {
      next.add(event);
    }
    const nextEvents = { ...channelEvents, [channel]: next };
    setChannelEvents(nextEvents);

    if (onChange) {
      // Wizard mode: lift state up; caller handles persistence.
      onChange(Object.fromEntries(
        Object.entries(nextEvents).map(([ch, set]) => [ch, [...set]])
      ));
    } else {
      saveGlobalChannelEvents(channel, [...next])
        .then(() => onSaved?.())
        .catch((err) => toast.error("Failed to save notification settings", { description: String(err) }));
    }
  }, [channelEvents, onChange, onSaved]);

  const handleToggleAll = useCallback((channel: ChannelId) => {
    const allOn = ALL_EVENTS.every((e) => channelEvents[channel].has(e));
    const newSet = allOn ? new Set<NotificationEventType>() : new Set(ALL_EVENTS);
    const nextEvents = { ...channelEvents, [channel]: newSet };
    setChannelEvents(nextEvents);

    if (onChange) {
      onChange(Object.fromEntries(
        Object.entries(nextEvents).map(([ch, set]) => [ch, [...set]])
      ));
    } else {
      saveGlobalChannelEvents(channel, [...newSet])
        .then(() => onSaved?.())
        .catch((err) => toast.error("Failed to save notification settings", { description: String(err) }));
    }
  }, [channelEvents, onChange, onSaved]);

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
            <th
              className="text-left py-2 pr-4 font-medium"
              style={{ color: "var(--text-muted)", width: "40%" }}
            >
              Event
            </th>
            {CHANNELS.map((ch) => {
              const Icon = ch.Icon;
              const disabled =
                (ch.id === "discord" && !discordConfigured) ||
                (ch.id === "email"   && !emailConfigured);
              const allOn  = ALL_EVENTS.every((e) => channelEvents[ch.id].has(e));
              const someOn = !allOn && ALL_EVENTS.some((e) => channelEvents[ch.id].has(e));
              return (
                <th
                  key={ch.id}
                  className="text-center pb-2 px-2"
                  style={{ color: disabled ? "var(--text-subtle)" : "var(--text-primary)", width: "15%" }}
                  title={ch.description}
                >
                  <div className="flex flex-col items-center gap-1">
                    <Icon className="w-3.5 h-3.5" />
                    <span>{ch.label}</span>
                    {disabled ? (
                      <span className="font-normal text-[9px]" style={{ color: "var(--text-subtle)" }}>
                        (not configured)
                      </span>
                    ) : (
                      <input
                        type="checkbox"
                        checked={allOn}
                        ref={(el) => { if (el) el.indeterminate = someOn; }}
                        onChange={() => handleToggleAll(ch.id)}
                        className="w-3 h-3 mt-0.5"
                        style={{ accentColor: "var(--neon-purple)", cursor: "pointer" }}
                        title={allOn ? `Disable all ${ch.label} notifications` : `Enable all ${ch.label} notifications`}
                      />
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
              style={{ background: i % 2 === 0 ? "rgba(255,255,255,0.02)" : "transparent" }}
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
                      className="w-3.5 h-3.5"
                      style={{
                        accentColor: "var(--neon-purple)",
                        opacity: disabled ? 0.3 : 1,
                        cursor: disabled ? "not-allowed" : "pointer",
                      }}
                      title={
                        disabled
                          ? "Configure credentials above to enable this channel"
                          : ch.id === "bell"
                          ? "Show in bell badge and popup (always logged and toasted)"
                          : undefined
                      }
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
});
NotificationMatrix.displayName = "NotificationMatrix";
