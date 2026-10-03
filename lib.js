'use strict';

const DAY = 86400000;

/** Start of the local day containing ms. */
function dayStart(ms) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}
function nextDay(ms) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
}
function dayKey(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Time-weighted integration of a step signal (value holds until next change).
 * points: [{t:ms, v:number|null}] sorted by t. null = unavailable (gap).
 * Returns { sum (value*hours), perDay: {key: value*hours}, coveredMs, peak }.
 */
function integrate(points, start, end) {
  const perDay = {};
  let sum = 0, coveredMs = 0, peak = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    let a = Math.max(p.t, start);
    const b = Math.min(i + 1 < points.length ? points[i + 1].t : end, end);
    if (p.v === null || b <= a) continue;
    if (p.v > peak) peak = p.v;
    coveredMs += b - a;
    while (a < b) {
      const e = Math.min(b, nextDay(a));
      const val = (p.v * (e - a)) / 3600000;
      sum += val;
      const k = dayKey(a);
      perDay[k] = (perDay[k] || 0) + val;
      a = e;
    }
  }
  return { sum, perDay, coveredMs, peak };
}

function parseHistory(raw) {
  const out = [];
  for (const row of raw || []) {
    const t = Date.parse(row.last_changed || row.last_updated);
    if (Number.isNaN(t)) continue;
    const v = parseFloat(row.state);
    out.push({ t, v: Number.isFinite(v) ? v : null });
  }
  out.sort((x, y) => x.t - y.t);
  return out;
}

function normalizeUrl(u) {
  return String(u || '').trim().replace(/\/+$/, '');
}

module.exports = { DAY, dayStart, nextDay, dayKey, integrate, parseHistory, normalizeUrl };
