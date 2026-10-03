'use strict';
const { dayStart, nextDay, dayKey, integrate, profile, percentile, msAbove } = require('./lib');

const MIN_DAY_MS = 20 * 3600000;   // Tag zählt nur mit ≥ 20 h Messwerten
const fmt = (n, d = 2) => Number(n).toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d });
const pad = (n) => String(n).padStart(2, '0');
const monthStart = (ms) => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), 1).getTime(); };
const addMonths = (ms, n) => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth() + n, 1).getTime(); };
const addDays = (ms, n) => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n).getTime(); };
const monthName = (ms) => new Date(ms).toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });
const dayName = (ms) => new Date(ms).toLocaleDateString('de-DE', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' });

/** Frühester benötigter Zeitpunkt für die Prüfung. */
const neededStart = (now) => addMonths(monthStart(now), -4);

function dayRows(pts, start, end) {
  const r = integrate(pts, start, end);
  const rows = [];
  for (let d = dayStart(start); d < end; d = nextDay(d)) {
    const k = dayKey(d);
    rows.push({ start: d, kwh: (r.perDay[k] || 0) / 1000, coveredMs: r.perDayMs[k] || 0 });
  }
  return rows;
}
const valid = (rows) => rows.filter((r) => r.coveredMs >= MIN_DAY_MS);
const dailyAvg = (rows) => (rows.length ? rows.reduce((t, r) => t + r.kwh, 0) / rows.length : 0);

/** Regelbasierte Ursachenanalyse: Vergleich Profil „aktuell“ vs. „Referenz“. */
function diagnose(pts, curRanges, refRanges) {
  const C = profile(pts, curRanges), R = profile(pts, refRanges);
  const causes = [];
  if (!C.coveredMs || !R.coveredMs) return { causes, C, R };
  const avgC = C.sumWh / (C.coveredMs / 3600000), avgR = R.sumWh / (R.coveredMs / 3600000);
  const baseC = percentile(C.segs, 0.1), baseR = percentile(R.segs, 0.1);

  // 1. Grundlast (Dauerverbrauch)
  if (baseC - baseR >= Math.max(5, baseR * 0.25)) {
    causes.push({ key: 'base', text: `Die Grundlast ist gestiegen: ${fmt(baseC, 0)} W statt ${fmt(baseR, 0)} W im Dauerbetrieb/Standby (ca. +${fmt(((baseC - baseR) * 24) / 1000)} kWh pro Tag). Typisch bei einem Gerät, das nicht mehr in den Standby geht, oder einem neuen Dauerverbraucher.` });
  }
  // 2. Laufzeit
  const thr = Math.max(baseR * 1.5, baseR + 20);
  const actC = (msAbove(C.segs, thr) / C.coveredMs) * 24, actR = (msAbove(R.segs, thr) / R.coveredMs) * 24;
  if (actC - actR >= Math.max(0.5, actR * 0.2)) {
    causes.push({ key: 'runtime', text: `Das Gerät war länger aktiv: durchschnittlich ${fmt(actC, 1)} Std. pro Tag über ${fmt(thr, 0)} W statt ${fmt(actR, 1)} Std. (längere Nutzung oder häufigere Einschaltzeiten).` });
  }
  // 3. Spitzenleistung
  if (C.peak > R.peak * 1.1 && C.peak - R.peak >= 50) {
    causes.push({ key: 'peak', text: `Die Spitzenleistung ist höher als im Vergleichszeitraum: ${fmt(C.peak, 0)} W statt maximal ${fmt(R.peak, 0)} W (stärkerer Verbraucher oder zusätzliche Last).` });
  }
  // 4. Zeitfenster mit dem größten Mehrverbrauch (3-Stunden-Fenster, zyklisch)
  const diffKwh = C.hourWh.map((_, h) => {
    const c = C.hourMs[h] ? C.hourWh[h] / (C.hourMs[h] / 3600000) : 0;
    const r = R.hourMs[h] ? R.hourWh[h] / (R.hourMs[h] / 3600000) : 0;
    return (c - r) / 1000; // kWh pro Tag in dieser Stunde
  });
  const pos = diffKwh.reduce((t, x) => t + Math.max(0, x), 0);
  if (pos >= 0.1) {
    let best = 0, bestH = 0;
    for (let h = 0; h < 24; h++) {
      const w = diffKwh[h] + diffKwh[(h + 1) % 24] + diffKwh[(h + 2) % 24];
      if (w > best) { best = w; bestH = h; }
    }
    if (best >= pos * 0.5 && best >= 0.08) {
      const to = (bestH + 3) % 24;
      const night = bestH >= 22 || bestH + 3 <= 7 ? ' (nachts – evtl. ungewollter Betrieb)' : '';
      causes.push({ key: 'window', text: `Der Mehrverbrauch konzentriert sich auf ${pad(bestH)}:00–${pad(to)}:00 Uhr${night}: ca. +${fmt(best)} kWh pro Tag in diesem Zeitfenster.` });
    }
  }
  if (!causes.length) {
    causes.push({ key: 'generic', text: `Der Verbrauch liegt gleichmäßig höher (Ø ${fmt(avgC, 0)} W statt ${fmt(avgR, 0)} W), ohne einzelnen auffälligen Treiber. Prüfe Geräteeinstellungen, angeschlossene Verbraucher oder geänderte Nutzungsgewohnheiten.` });
  }
  return { causes, C, R };
}

/**
 * Führt beide Prüfungen aus.
 * pts: Leistungs-Stufensignal; s: Einstellungen; now: ms
 */
function runChecks(pts, s, now = Date.now()) {
  const price = Number(s.pricePerKwh) || 0;
  const dayPct = Number(s.alertDayPct) || 30, monthPct = Number(s.alertMonthPct) || 25, minKwh = Number(s.alertMinKwh) || 0.2;
  const checks = [], findings = [];

  /* --- Tag vs. vorherige 7 Tage --- */
  {
    const dEnd = dayStart(now), dStart = addDays(dEnd, -1), rStart = addDays(dStart, -7);
    const cur = dayRows(pts, dStart, dEnd)[0];
    const refRows = valid(dayRows(pts, rStart, dStart));
    const c = { kind: 'day', title: 'Gestern vs. vorherige 7 Tage' };
    if (!cur || cur.coveredMs < MIN_DAY_MS) checks.push({ ...c, status: 'skipped', note: 'Für gestern liegen zu wenige Messwerte vor.' });
    else if (refRows.length < 3) checks.push({ ...c, status: 'skipped', note: `Zu wenige Vergleichstage (${refRows.length} von 7 mit Messwerten, mind. 3 nötig).` });
    else {
      const ref = dailyAvg(refRows), diff = cur.kwh - ref, pct = ref > 0 ? (diff / ref) * 100 : (cur.kwh > 0 ? Infinity : 0);
      const hit = pct >= dayPct && diff >= minKwh;
      const info = { ...c, current: cur.kwh, reference: ref, deltaPct: pct, deltaKwh: diff, refDays: refRows.length, label: dayName(dStart), refLabel: `Ø der letzten ${refRows.length} Tage davor` };
      checks.push({ ...info, status: hit ? 'alert' : 'ok', note: hit ? 'Auffällig erhöht.' : `Unauffällig (Schwelle +${dayPct} % und ${fmt(minKwh)} kWh).` });
      if (hit) {
        const d = diagnose(pts, [[dStart, dEnd]], refRows.map((r) => [r.start, nextDay(r.start)]));
        findings.push({ ...info, id: dayKey(dStart), extraCost: diff * price, causes: d.causes.map((x) => x.text) });
      }
    }
  }

  /* --- Monat vs. vorherige Monate --- */
  {
    const thisM = monthStart(now), dom = new Date(now).getDate();
    const closed = dom <= 2; // Monatsanfang: abgeschlossenen Vormonat prüfen
    const cStart = closed ? addMonths(thisM, -1) : thisM, cEnd = closed ? thisM : dayStart(now);
    const refMonths = [1, 2, 3].map((i) => addMonths(cStart, -i));
    const c = { kind: 'month', title: closed ? 'Letzter Monat vs. 3 Monate davor' : 'Aktueller Monat vs. 3 Vormonate' };
    const curRows = valid(dayRows(pts, cStart, cEnd));
    const refRowsAll = refMonths.map((m) => valid(dayRows(pts, m, addMonths(m, 1))));
    const usableRefs = refMonths.map((m, i) => ({ m, rows: refRowsAll[i] })).filter((x) => x.rows.length >= 10);
    if (curRows.length < 3) checks.push({ ...c, status: 'skipped', note: `Zu wenige Messtage im Monat (${curRows.length}, mind. 3 nötig).` });
    else if (!usableRefs.length) checks.push({ ...c, status: 'skipped', note: 'Keine Vormonate mit ausreichend Messwerten (mind. 10 Tage).' });
    else {
      const ref = dailyAvg(usableRefs.flatMap((x) => x.rows)), cur = dailyAvg(curRows);
      const diff = cur - ref, pct = ref > 0 ? (diff / ref) * 100 : (cur > 0 ? Infinity : 0);
      const hit = pct >= monthPct && diff >= minKwh;
      const info = { ...c, current: cur, reference: ref, deltaPct: pct, deltaKwh: diff, refDays: usableRefs.length, curDays: curRows.length,
        label: closed ? monthName(cStart) : `${monthName(cStart)} (bis gestern)`, refLabel: `Ø ${usableRefs.length} Vormonat${usableRefs.length > 1 ? 'e' : ''} (${usableRefs.map((x) => new Date(x.m).toLocaleDateString('de-DE', { month: 'short' })).join(', ')})` };
      checks.push({ ...info, status: hit ? 'alert' : 'ok', note: hit ? 'Auffällig erhöht.' : `Unauffällig (Schwelle +${monthPct} % und ${fmt(minKwh)} kWh/Tag).` });
      if (hit) {
        const d = diagnose(pts, curRows.map((r) => [r.start, nextDay(r.start)]), usableRefs.flatMap((x) => x.rows.map((r) => [r.start, nextDay(r.start)])));
        findings.push({ ...info, id: `${cStart}`, extraCost: diff * curRows.length * price, causes: d.causes.map((x) => x.text) });
      }
    }
  }
  return { checks, findings };
}

/* ---------- Mail ---------- */

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function buildAlertMail(findings, s) {
  const cur = s.currency || '€';
  const pctS = (f) => (Number.isFinite(f.deltaPct) ? `+${fmt(f.deltaPct, 0)} %` : 'deutlich höher');
  const kindName = { day: 'Tag', month: 'Monat' };
  const subject = `Stromrechner: Erhöhter Verbrauch (${findings.map((f) => `${kindName[f.kind]} ${pctS(f)}`).join(', ')})`;

  const text = ['Stromrechner – Verbrauchswarnung', '='.repeat(32), ''];
  for (const f of findings) {
    text.push(`${f.kind === 'day' ? 'TAGESVERGLEICH' : 'MONATSVERGLEICH'}: ${f.label}`,
      `Verbrauch pro Tag: ${fmt(f.current)} kWh (Vergleich: ${fmt(f.reference)} kWh, ${f.refLabel})`,
      `Abweichung: ${pctS(f)} / +${fmt(f.deltaKwh)} kWh pro Tag, Mehrkosten ca. ${fmt(f.extraCost)} ${cur}`,
      '', 'Mögliche Ursachen:', ...f.causes.map((c) => `  - ${c}`), '');
  }
  text.push('Diese Auswertung wird regelbasiert aus den Home-Assistant-Messwerten berechnet.');

  const card = (f) => `
    <tr><td style="padding:0 0 18px">
      <div style="font-size:12px;letter-spacing:.8px;text-transform:uppercase;color:#8793a8;font-weight:700">${f.kind === 'day' ? 'Tagesvergleich' : 'Monatsvergleich'}</div>
      <div style="font-size:17px;font-weight:700;margin:2px 0 12px;color:#111827">${esc(f.label)}</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:8px;border-collapse:separate;font-size:14px">
        <tr><td style="padding:10px 14px;color:#6b7280">Verbrauch pro Tag</td><td align="right" style="padding:10px 14px;font-weight:700">${fmt(f.current)} kWh</td></tr>
        <tr><td style="padding:10px 14px;color:#6b7280;border-top:1px solid #e5e7eb">Vergleich (${esc(f.refLabel)})</td><td align="right" style="padding:10px 14px;border-top:1px solid #e5e7eb">${fmt(f.reference)} kWh</td></tr>
        <tr><td style="padding:10px 14px;color:#6b7280;border-top:1px solid #e5e7eb">Abweichung</td><td align="right" style="padding:10px 14px;border-top:1px solid #e5e7eb;color:#b91c1c;font-weight:700">${pctS(f)} (+${fmt(f.deltaKwh)} kWh/Tag)</td></tr>
        <tr><td style="padding:10px 14px;color:#6b7280;border-top:1px solid #e5e7eb">Mehrkosten</td><td align="right" style="padding:10px 14px;border-top:1px solid #e5e7eb">ca. ${fmt(f.extraCost)} ${esc(cur)}</td></tr>
      </table>
      <div style="font-size:13px;font-weight:700;margin:14px 0 6px;color:#111827">Mögliche Ursachen</div>
      <ul style="margin:0;padding-left:20px;font-size:14px;color:#374151">${f.causes.map((c) => `<li style="margin-bottom:6px">${esc(c)}</li>`).join('')}</ul>
    </td></tr>`;
  const html = `<!doctype html><html><body style="margin:0;background:#f3f4f6;font-family:Segoe UI,Roboto,Arial,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb">
    <tr><td style="background:#0a0d13;padding:18px 24px;color:#fff;font-size:18px;font-weight:700;border-bottom:3px solid #f2b01e">&#9889; Stromrechner <span style="color:#f2b01e;font-weight:500;font-size:14px">· Verbrauchswarnung</span></td></tr>
    <tr><td style="padding:24px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${findings.map(card).join('')}</table>
      <div style="font-size:12px;color:#9ca3af;border-top:1px solid #e5e7eb;padding-top:12px">Regelbasierte Auswertung der Home-Assistant-Messwerte (Mittelwerte).</div></td></tr>
  </table></td></tr></table></body></html>`;
  return { subject, text: text.join('\n'), html };
}

function buildTestMail() {
  return {
    subject: 'Stromrechner: Testmail',
    text: 'Die SMTP-Verbindung funktioniert. Verbrauchswarnungen werden an diese Adresse gesendet.',
    html: '<div style="font-family:Segoe UI,Arial,sans-serif;padding:16px"><b>Stromrechner</b><p>Die SMTP-Verbindung funktioniert. Verbrauchswarnungen werden an diese Adresse gesendet.</p></div>',
  };
}

module.exports = { runChecks, buildAlertMail, buildTestMail, neededStart, diagnose };
