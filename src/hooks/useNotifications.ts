"use client";

/**
 * useNotifications — TanStack Query hooks for in-app notification data.
 *
 * `unreadBump` from Zustand is included in query keys so the counts and lists
 * refresh automatically each time `dispatchNotification` logs a new entry.
 */

import { useQuery } from "@tanstack/react-query";
import { useAppStore } from "@/store/useAppStore";
import {
  getUnreadNotificationCount,
  getNotifications,
  type GetNotificationsFilter,
} from "@/lib/db";

/** Returns the current unread notification count from SQLite. */
export function useUnreadNotificationCount() {
  const unreadBump = useAppStore((s) => s.unreadBump);
  return useQuery({
    queryKey: ["notifications", "unread", unreadBump],
    queryFn: getUnreadNotificationCount,
    staleTime: 0,
  });
}

/** Returns a list of notifications matching the given filter. */
export function useNotificationList(filter: GetNotificationsFilter = {}) {
  const unreadBump = useAppStore((s) => s.unreadBump);
  return useQuery({
    queryKey: ["notifications", "list", filter, unreadBump],
    queryFn: () => getNotifications(filter),
    staleTime: 0,
  });
}
