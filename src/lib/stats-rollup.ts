import { rollupOldStats } from "./db";

/**
 * Roll up raw stat history rows older than 30 days into daily aggregates and
 * prune data beyond the 1-year retention window.
 *
 * Called on app startup and every 24 hours by ServerStatsRecorderProvider.
 */
export async function runStatsRollup(): Promise<void> {
  await rollupOldStats();
}
