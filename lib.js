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
  const perDay = {}, perDayMs = {};
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
      perDayMs[k] = (perDayMs[k] || 0) + (e - a);
      a = e;
    }
  }
  return { sum, perDay, perDayMs, coveredMs, peak };
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

/**
 * Profil über mehrere Zeitbereiche: Wh und Messzeit je Tagesstunde, Leistungsverteilung, Spitze.
 * ranges: [[startMs, endMs], ...]
 */
function profile(points, ranges) {
  const hourWh = new Array(24).fill(0), hourMs = new Array(24).fill(0);
  const segs = [];
  let coveredMs = 0, sumWh = 0, peak = 0;
  for (const [start, end] of ranges) {
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      let a = Math.max(p.t, start);
      const b = Math.min(i + 1 < points.length ? points[i + 1].t : end, end);
      if (p.v === null || b <= a) continue;
      segs.push([p.v, b - a]);
      coveredMs += b - a;
      if (p.v > peak) peak = p.v;
      while (a < b) {
        const d = new Date(a);
        const e = Math.min(b, new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + 1).getTime());
        const h = d.getHours();
        hourWh[h] += (p.v * (e - a)) / 3600000;
        hourMs[h] += e - a;
        sumWh += (p.v * (e - a)) / 3600000;
        a = e;
      }
    }
  }
  return { hourWh, hourMs, segs, coveredMs, sumWh, peak };
}

/** Zeitgewichtetes Perzentil (0..1) der Leistungswerte. */
function percentile(segs, q) {
  if (!segs.length) return 0;
  const sorted = [...segs].sort((x, y) => x[0] - y[0]);
  const total = sorted.reduce((t, x) => t + x[1], 0);
  let acc = 0;
  for (const [v, ms] of sorted) { acc += ms; if (acc >= q * total) return v; }
  return sorted[sorted.length - 1][0];
}

/** Zeit (ms) mit Leistung über einer Schwelle. */
function msAbove(segs, thr) {
  return segs.reduce((t, [v, ms]) => (v > thr ? t + ms : t), 0);
}

module.exports = { profile, percentile, msAbove, DAY, dayStart, nextDay, dayKey, integrate, parseHistory, normalizeUrl };
