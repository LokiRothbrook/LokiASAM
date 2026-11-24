/**
 * tour.ts — runs a guided tour (driver.js) from a TourDef in data/tours.ts and
 * remembers which tours (and versions) the user has seen.
 */

import { driver, type DriveStep } from "driver.js";
import { getAppSetting, setAppSetting, deleteAppSettingsWithPrefix } from "@/lib/db";
import type { TourDef } from "@/data/tours";

const SEEN_PREFIX = "tour_seen_";
const seenKey = (def: TourDef) => `${SEEN_PREFIX}${def.id}`;

let active = false;

export async function hasSeenTour(def: TourDef): Promise<boolean> {
  const v = parseInt((await getAppSetting(seenKey(def)).catch(() => null)) ?? "", 10);
  return !isNaN(v) && v >= def.version;
}

/** Forget every tour so each shows again (Settings → Restart guided tours). */
export async function resetAllTours(): Promise<void> {
  await deleteAppSettingsWithPrefix(SEEN_PREFIX);
}

/**
 * Start a tour. Steps whose target isn't on screen are skipped. Returns false
 * (and doesn't mark the tour seen) when nothing could be shown or another
 * tour is already running.
 */
export function runTour(def: TourDef, opts: { onDone?: () => void } = {}): boolean {
  if (active || typeof document === "undefined") return false;

  const steps: DriveStep[] = def.steps.flatMap((s) => {
    const popover = { title: s.title, description: s.body, side: s.side, align: "start" as const };
    if (!s.target) return [{ popover }];
    const el = document.querySelector(`[data-tour="${s.target}"]`);
    return el ? [{ element: el, popover }] : [];
  });
  if (!steps.some((s) => s.element) && steps.length < 2) return false;

  active = true;
  const tour = driver({
    steps,
    showProgress: steps.length > 1,
    progressText: "{{current}} of {{total}}",
    nextBtnText: "Next",
    prevBtnText: "Back",
    doneBtnText: "Done",
    popoverClass: "lokiasam-tour",
    overlayColor: "#000",
    overlayOpacity: 0.6,
    stagePadding: 6,
    stageRadius: 10,
    smoothScroll: true,
    allowClose: true,
    onDestroyed: () => {
      active = false;
      // Finished or dismissed — either way, don't show it again automatically.
      setAppSetting(seenKey(def), String(def.version)).catch(() => {});
      opts.onDone?.();
    },
  });
  tour.drive();
  return true;
}
