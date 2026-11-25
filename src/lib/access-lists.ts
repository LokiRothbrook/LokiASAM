/**
 * access-lists.ts — keeps the two editors of a server's player access files
 * (the RCON console's ban/whitelist panels and the Config tab's Admins &
 * Whitelist card) in step: whichever one changes a file announces it, and
 * the other reloads.
 */

export const ACCESS_LISTS_CHANGED_EVENT = "lokiasam:access-lists-changed";

/** Announce that a server's ban / whitelist / admin files changed on disk. */
export function notifyAccessListsChanged(serverId: string): void {
  window.dispatchEvent(new CustomEvent<string>(ACCESS_LISTS_CHANGED_EVENT, { detail: serverId }));
}
