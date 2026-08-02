"use strict";
/**
 * Time math for the nightly sync, kept pure and separate from server.js (which
 * starts listening on require) so it can be unit-tested.
 */

/** Milliseconds from `now` until the next occurrence of hh:00 UTC. An exact hit
 *  on the hour schedules the NEXT day — the run that fired is already underway. */
function msUntilUtcHour(hour, now = new Date()) {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, 0, 0, 0));
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next - now;
}

/** NIGHTLY_SYNC_UTC_HOUR parsing: unset/blank -> default 7 (≈ 2-3am US Eastern),
 *  "off" -> null (disabled), otherwise an integer hour 0-23 (invalid -> default). */
function nightlyHour(raw, dflt = 7) {
  if (raw == null || String(raw).trim() === "") return dflt;
  if (String(raw).trim().toLowerCase() === "off") return null;
  const h = Number(raw);
  return Number.isInteger(h) && h >= 0 && h <= 23 ? h : dflt;
}

module.exports = { msUntilUtcHour, nightlyHour };
