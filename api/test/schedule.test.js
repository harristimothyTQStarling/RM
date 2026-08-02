"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { msUntilUtcHour, nightlyHour } = require("../src/schedule");

const HOUR = 3600e3;

test("hour later today -> delay within the same day", () => {
  const now = new Date(Date.UTC(2026, 7, 2, 3, 0, 0));          // 03:00 UTC
  assert.equal(msUntilUtcHour(7, now), 4 * HOUR, "03:00 -> 07:00 is 4h");
});

test("hour already passed -> tomorrow", () => {
  const now = new Date(Date.UTC(2026, 7, 2, 9, 30, 0));         // 09:30 UTC
  assert.equal(msUntilUtcHour(7, now), 21.5 * HOUR, "09:30 -> 07:00 next day");
});

test("exactly on the hour -> a full day (that run is already firing)", () => {
  const now = new Date(Date.UTC(2026, 7, 2, 7, 0, 0));
  assert.equal(msUntilUtcHour(7, now), 24 * HOUR);
});

test("month/year rollover is handled by Date, not by us", () => {
  const now = new Date(Date.UTC(2026, 11, 31, 23, 0, 0));       // Dec 31 23:00
  assert.equal(msUntilUtcHour(7, now), 8 * HOUR, "crosses into Jan 1");
});

test("nightlyHour parsing: default, off, valid, invalid", () => {
  assert.equal(nightlyHour(undefined), 7, "unset -> default");
  assert.equal(nightlyHour(""), 7, "blank -> default (not hour 0)");
  assert.equal(nightlyHour("off"), null, "off -> disabled");
  assert.equal(nightlyHour("OFF "), null, "case/space tolerant");
  assert.equal(nightlyHour("0"), 0, "midnight UTC is a valid choice");
  assert.equal(nightlyHour("23"), 23);
  assert.equal(nightlyHour("24"), 7, "out of range -> default");
  assert.equal(nightlyHour("7.5"), 7, "non-integer -> default");
  assert.equal(nightlyHour("banana"), 7, "garbage -> default");
});
