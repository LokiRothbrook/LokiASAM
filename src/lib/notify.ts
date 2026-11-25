/**
 * notify.ts — the app's toast API. Use this instead of sonner's `toast` for
 * anything the user should be told about.
 *
 * Every call goes through dispatchNotification, so it:
 *  - shows the toast (unless the In-App column is unticked for its event),
 *  - is logged on the Notifications page (and the bell, if ticked),
 *  - can go to desktop / Discord / SMTP like any other event.
 *
 * The event defaults by severity — errors → "Other Errors", warnings →
 * "Warnings", success/info → "Confirmations & Info" — and can be set to a
 * more specific one (rcon_error, server_action_failed, backup_failed, …).
 * Pass `server` for anything about a server: the name is added to the title
 * when it isn't already there, and per-server notification settings apply.
 *
 * Plain sonner is still fine for transient UI that isn't an event: loading
 * spinners and progress toasts that update in place (toast.loading / an id
 * that's reused) and their dismissal.
 */

import type { ExternalToast } from "sonner";
import { dispatchNotification, type DispatchNotificationParams } from "@/lib/notifications";
import type { NotificationEventType } from "@/data/game-data";

type Severity = DispatchNotificationParams["severity"];

export interface NotifyServer {
  id: string;
  name: string;
}

export interface NotifyOptions extends Omit<ExternalToast, "description"> {
  /** Detail line. Errors and other values are stringified. */
  description?: unknown;
  /** The server this is about, if any. */
  server?: NotifyServer | null;
  /** Override the default event category for this severity. */
  event?: NotificationEventType;
}

const DEFAULT_EVENT: Record<Severity, NotificationEventType> = {
  error:   "app_error",
  warning: "app_warning",
  success: "action_completed",
  info:    "action_completed",
};

function send(severity: Severity, title: string, opts: NotifyOptions = {}): void {
  const { description, server, event, ...toastOptions } = opts;
  void dispatchNotification({
    eventType:  event ?? DEFAULT_EVENT[severity],
    serverId:   server?.id ?? null,
    serverName: server?.name ?? "",
    title,
    body:       description === undefined || description === null ? "" : String(description),
    severity,
    toastOptions,
  });
}

export const notify = {
  success: (title: string, opts?: NotifyOptions) => send("success", title, opts),
  info:    (title: string, opts?: NotifyOptions) => send("info", title, opts),
  warning: (title: string, opts?: NotifyOptions) => send("warning", title, opts),
  error:   (title: string, opts?: NotifyOptions) => send("error", title, opts),
};

type BoundNotify = typeof notify;
const bound = new Map<string, BoundNotify>();

const boundNames = new Map<string, string>();

/**
 * `notify` with `server` pre-filled — for components scoped to one server.
 * Returns the same object for the same server id (picking up a rename), so
 * it's safe in useCallback/useEffect deps without ever changing them.
 */
export function serverNotify(server: NotifyServer): BoundNotify {
  boundNames.set(server.id, server.name);
  let n = bound.get(server.id);
  if (!n) {
    const id = server.id;
    const bind = (severity: Severity) => (title: string, opts?: NotifyOptions) =>
      send(severity, title, { server: { id, name: boundNames.get(id) ?? "" }, ...opts });
    n = { success: bind("success"), info: bind("info"), warning: bind("warning"), error: bind("error") };
    bound.set(id, n);
  }
  return n;
}
