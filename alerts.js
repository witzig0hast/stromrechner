'use strict';
const { dayStart, nextDay, dayKey, integrate, profile, percentile, msAbove } = require('./lib');

const MIN_DAY_MS = 20 * 3600000;   // Tag zählt nur mit ≥ 20 h Messwerten
const fmt = (n, d = 2) => Number(n).toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d });
const pad = (n) => String(n).padStart(2, '0');
const monthStart = (ms) => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), 1).getTime(); };
const addMonths = (ms, n) => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth() + n, 1).getTime(); };
const addDays = (ms, n) => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n).getTime(); };
const monthName = (ms) => new Date(ms).toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });
const monthShort = (ms) => new Date(ms).toLocaleDateString('de-DE', { month: 'short', year: '2-digit' });
const dayName = (ms) => new Date(ms).toLocaleDateString('de-DE', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' });
const dayShort = (ms) => new Date(ms).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' });
const weekdayName = (ms) => new Date(ms).toLocaleDateString('de-DE', { weekday: 'long' });

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

/* ---------- Ursachenanalyse (regelbasiert, ohne KI) ---------- */

/** Vergleich Profil „aktuell“ vs. „Referenz“: liefert Ursachen mit Erklärung + Tipp und Kennzahlen. */
function diagnose(pts, curRanges, refRanges) {
  const C = profile(pts, curRanges), R = profile(pts, refRanges);
  const causes = [];
  if (!C.coveredMs || !R.coveredMs) return { causes, metrics: null };
  const avgC = C.sumWh / (C.coveredMs / 3600000), avgR = R.sumWh / (R.coveredMs / 3600000);
  const baseC = percentile(C.segs, 0.1), baseR = percentile(R.segs, 0.1);
  const thr = Math.max(baseR * 1.5, baseR + 20);
  const actC = (msAbove(C.segs, thr) / C.coveredMs) * 24, actR = (msAbove(R.segs, thr) / R.coveredMs) * 24;
  const hourW = (P) => P.hourWh.map((wh, h) => (P.hourMs[h] ? wh / (P.hourMs[h] / 3600000) : 0));
  const hourC = hourW(C), hourR = hourW(R);
  const metrics = { avgC, avgR, baseC, baseR, peakC: C.peak, peakR: R.peak, actC, actR, thr, hourC, hourR };

  // 1. Grundlast (Dauer-/Standby-Verbrauch)
  if (baseC - baseR >= Math.max(5, baseR * 0.25)) {
    causes.push({
      key: 'base', title: 'Die Grundlast ist gestiegen',
      text: `Im ruhigsten Betrieb zieht die Steckdose jetzt ${fmt(baseC, 0)} W statt ${fmt(baseR, 0)} W. Das sind rund ${fmt(((baseC - baseR) * 24) / 1000)} kWh pro Tag, die rund um die Uhr zusätzlich anfallen.`,
      tip: 'Geht ein Gerät nicht mehr in den Standby oder wurde ein Dauerverbraucher (Ladegerät, Netzteil, neues Gerät) angesteckt? Prüfe auch Zeitschaltuhren und Automationen, die das Gerät nicht mehr abschalten.',
    });
  }
  // 2. Laufzeit
  if (actC - actR >= Math.max(0.5, actR * 0.2)) {
    causes.push({
      key: 'runtime', title: 'Das Gerät war länger aktiv',
      text: `Es lief durchschnittlich ${fmt(actC, 1)} Std. pro Tag mit mehr als ${fmt(thr, 0)} W, zuvor waren es ${fmt(actR, 1)} Std.`,
      tip: 'Hat sich die Nutzung geändert (längere Betriebszeiten, häufigeres Einschalten)? Prüfe Zeitpläne und Automationen in Home Assistant, die das Gerät einschalten.',
    });
  }
  // 3. Spitzenleistung
  if (C.peak > R.peak * 1.1 && C.peak - R.peak >= 50) {
    causes.push({
      key: 'peak', title: 'Höhere Spitzenleistung',
      text: `Die Spitze lag bei ${fmt(C.peak, 0)} W, im Vergleichszeitraum maximal bei ${fmt(R.peak, 0)} W.`,
      tip: 'Ein stärkerer oder zusätzlicher Verbraucher? Ein defektes Gerät (Kompressor, Heizstab) oder eine geänderte Einstellung (höhere Stufe, Heiz-/Kühlfunktion) kann solche Spitzen verursachen.',
    });
  }
  // 4. Zeitfenster mit dem größten Mehrverbrauch (3-Stunden-Fenster, zyklisch)
  const diffKwh = hourC.map((c, h) => (c - hourR[h]) / 1000); // kWh pro Tag in dieser Stunde
  const pos = diffKwh.reduce((t, x) => t + Math.max(0, x), 0);
  if (pos >= 0.1) {
    let best = 0, bestH = 0;
    for (let h = 0; h < 24; h++) {
      const w = diffKwh[h] + diffKwh[(h + 1) % 24] + diffKwh[(h + 2) % 24];
      if (w > best) { best = w; bestH = h; }
    }
    if (best >= pos * 0.5 && best >= 0.08) {
      const to = (bestH + 3) % 24;
      const night = bestH >= 22 || bestH + 3 <= 7;
      causes.push({
        key: 'window', title: `Mehrverbrauch zwischen ${pad(bestH)}:00 und ${pad(to)}:00 Uhr`,
        text: `In diesem Zeitfenster fielen ca. ${fmt(best)} kWh pro Tag mehr an als sonst – der größte Teil des Mehrverbrauchs.`,
        tip: night
          ? 'Nachts läuft etwas, das sonst nicht läuft. Prüfe Zeitschaltungen, Automationen, Geräte im Dauerbetrieb oder ob jemand das Gerät nachts genutzt hat.'
          : 'Überlege, was in diesem Zeitfenster neu oder länger eingeschaltet wird (Nutzung, Zeitplan, Automation).',
      });
    }
  }
  if (!causes.length) {
    causes.push({
      key: 'generic', title: 'Gleichmäßig höherer Verbrauch',
      text: `Der Verbrauch liegt insgesamt höher (Ø ${fmt(avgC, 0)} W statt ${fmt(avgR, 0)} W), ohne einen einzelnen auffälligen Treiber in Grundlast, Laufzeit, Spitzen oder Tageszeit.`,
      tip: 'Mögliche Gründe: geänderte Nutzung, Wetter bzw. Temperatur (Heizen/Kühlen), ein weiterer Verbraucher hinter der Steckdose oder ein schleichender Defekt. Vergleiche mit den Tagen davor.',
    });
  }
  return { causes, metrics };
}

/* ---------- Prüfungen ---------- */

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
        // Wochentags-Einordnung: gleicher Wochentag in den letzten 4 Wochen
        const sameDay = valid(dayRows(pts, addDays(dStart, -28), dStart)).filter((r) => new Date(r.start).getDay() === new Date(dStart).getDay());
        let weekday = null;
        if (sameDay.length >= 2) {
          const avg = dailyAvg(sameDay), p = avg > 0 ? ((cur.kwh - avg) / avg) * 100 : Infinity;
          weekday = { name: weekdayName(dStart), avg, n: sameDay.length, deltaPct: p, normal: p < dayPct };
        }
        findings.push({
          ...info, id: dayKey(dStart), causes: d.causes, metrics: d.metrics, weekday,
          extraCost: diff * price, extraCostMonth: diff * 30 * price, extraCostYear: diff * 365 * price,
          rule: { pct: dayPct, minKwh, text: `Gestern lag der Verbrauch mindestens ${fmt(dayPct, 0)} % und mindestens ${fmt(minKwh)} kWh über dem Durchschnitt der ${refRows.length} Tage davor.` },
          series: [...refRows.map((r) => ({ label: dayShort(r.start), kwh: r.kwh })), { label: `${dayShort(dStart)} (gestern)`, kwh: cur.kwh, current: true }],
          unit: 'kWh pro Tag', cost: cur.kwh * price, price,
        });
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
        findings.push({
          ...info, id: `${cStart}`, causes: d.causes, metrics: d.metrics, weekday: null,
          extraCost: diff * curRows.length * price, extraCostMonth: diff * 30 * price, extraCostYear: diff * 365 * price,
          rule: { pct: monthPct, minKwh, text: `Der tägliche Durchschnittsverbrauch lag mindestens ${fmt(monthPct, 0)} % und mindestens ${fmt(minKwh)} kWh pro Tag über dem Durchschnitt der Vergleichsmonate.` },
          series: [...usableRefs.slice().reverse().map((x) => ({ label: monthShort(x.m), kwh: dailyAvg(x.rows) })), { label: `${monthShort(cStart)} (aktuell)`, kwh: cur, current: true }],
          unit: 'kWh pro Tag (Monatsdurchschnitt)', cost: cur * price, price,
        });
      }
    }
  }
  return { checks, findings };
}

/* ---------- Mail ---------- */

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const C = { text: '#111827', mute: '#6b7280', line: '#e5e7eb', soft: '#f9fafb', accent: '#f2b01e', red: '#b91c1c', redSoft: '#fef2f2', gray: '#9ca3af', blue: '#2563eb' };

const pctText = (f) => (Number.isFinite(f.deltaPct) ? `${fmt(f.deltaPct, 0)} %` : 'deutlich');
const sentence = (f) => f.kind === 'day'
  ? `Gestern (${f.label}) hat die Steckdose ${fmt(f.current)} kWh verbraucht – das sind ${pctText(f)} mehr als im Durchschnitt der ${f.refDays} Tage davor (${fmt(f.reference)} kWh).`
  : `Im ${f.label} verbraucht die Steckdose im Schnitt ${fmt(f.current)} kWh pro Tag – das sind ${pctText(f)} mehr als im Durchschnitt der Vergleichsmonate (${fmt(f.reference)} kWh pro Tag).`;
const title = (f) => (f.kind === 'day' ? 'Tagesvergleich' : 'Monatsvergleich');

function barRows(series) {
  const max = Math.max(...series.map((x) => x.kwh), 0.001);
  return series.map((x) => `
    <tr><td style="padding:4px 10px 4px 0;font-size:13px;color:${x.current ? C.text : C.mute};font-weight:${x.current ? 700 : 400};white-space:nowrap;width:150px">${esc(x.label)}</td>
    <td style="padding:4px 0"><div style="background:${C.line};border-radius:4px"><div style="background:${x.current ? C.red : C.gray};height:14px;border-radius:4px;width:${Math.max(2, Math.round((x.kwh / max) * 100))}%"></div></div></td>
    <td align="right" style="padding:4px 0 4px 10px;font-size:13px;font-weight:${x.current ? 700 : 400};color:${C.text};white-space:nowrap;width:80px">${fmt(x.kwh)} kWh</td></tr>`).join('');
}

function hourChart(m) {
  const max = Math.max(...m.hourC, ...m.hourR, 1), H = 64;
  const col = (h) => `<td valign="bottom" align="center" style="padding:0 1px;font-size:0;line-height:0">
      <div style="display:inline-block;width:5px;height:${Math.max(1, Math.round((m.hourR[h] / max) * H))}px;background:${C.gray}"></div><div style="display:inline-block;width:5px;height:${Math.max(1, Math.round((m.hourC[h] / max) * H))}px;background:${C.red}"></div></td>`;
  const lab = (h) => `<td align="center" style="font-size:10px;color:${C.mute};padding-top:3px">${h % 3 === 0 ? pad(h) : ''}</td>`;
  const hours = [...Array(24).keys()];
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="height:${H}px"><tr>${hours.map(col).join('')}</tr><tr>${hours.map(lab).join('')}</tr></table>
    <div style="font-size:12px;color:${C.mute};margin-top:6px"><span style="color:${C.gray}">&#9632;</span> Vergleich (Ø Leistung je Uhrzeit) &nbsp; <span style="color:${C.red}">&#9632;</span> aktuell &nbsp; Spitze der Skala: ${fmt(max, 0)} W</div>`;
}

function metricRows(f) {
  const m = f.metrics;
  if (!m) return '';
  const row = (name, cur, ref, unit, d = 0) => {
    const diff = ref > 0 ? ((cur - ref) / ref) * 100 : null;
    const flag = diff !== null && diff >= 15 ? `color:${C.red};font-weight:700` : `color:${C.text}`;
    return `<tr><td style="padding:9px 12px;border-top:1px solid ${C.line};color:${C.mute};font-size:14px">${name}</td>
      <td align="right" style="padding:9px 12px;border-top:1px solid ${C.line};font-size:14px;${flag}">${fmt(cur, d)} ${unit}</td>
      <td align="right" style="padding:9px 12px;border-top:1px solid ${C.line};font-size:14px">${fmt(ref, d)} ${unit}</td>
      <td align="right" style="padding:9px 12px;border-top:1px solid ${C.line};font-size:14px;${flag}">${diff === null ? '–' : (diff >= 0 ? '+' : '') + fmt(diff, 0) + ' %'}</td></tr>`;
  };
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C.line};border-radius:8px;border-collapse:separate;background:#fff">
    <tr><td style="padding:9px 12px;font-size:12px;color:${C.mute};font-weight:700;text-transform:uppercase;letter-spacing:.5px">Kennzahl</td><td align="right" style="padding:9px 12px;font-size:12px;color:${C.mute};font-weight:700;text-transform:uppercase">Aktuell</td><td align="right" style="padding:9px 12px;font-size:12px;color:${C.mute};font-weight:700;text-transform:uppercase">Vergleich</td><td align="right" style="padding:9px 12px;font-size:12px;color:${C.mute};font-weight:700;text-transform:uppercase">Abw.</td></tr>
    ${row('Durchschnittliche Leistung', m.avgC, m.avgR, 'W')}
    ${row('Grundlast (ruhigster Betrieb)', m.baseC, m.baseR, 'W')}
    ${row('Spitzenleistung', m.peakC, m.peakR, 'W')}
    ${row(`Aktive Zeit (über ${fmt(m.thr, 0)} W)`, m.actC, m.actR, 'Std./Tag', 1)}
    ${row('Verbrauch pro Tag', f.current, f.reference, 'kWh', 2)}
  </table>`;
}

function card(f, s) {
  const cur = esc(s.currency || '€');
  const causes = f.causes.map((c, i) => `
    <tr><td style="padding:0 0 12px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-left:4px solid ${C.accent};background:${C.soft};border-radius:0 8px 8px 0">
      <tr><td style="padding:12px 14px">
        <div style="font-size:15px;font-weight:700;color:${C.text}">${i + 1}. ${esc(c.title)}</div>
        <div style="font-size:14px;color:#374151;margin:4px 0 8px;line-height:1.5">${esc(c.text)}</div>
        <div style="font-size:13px;color:${C.mute};line-height:1.5"><b style="color:${C.text}">Was du prüfen kannst:</b> ${esc(c.tip)}</div>
      </td></tr></table></td></tr>`).join('');
  const wd = f.weekday ? `<div style="font-size:13px;color:${f.weekday.normal ? '#92400e' : C.mute};background:${f.weekday.normal ? '#fffbeb' : C.soft};border:1px solid ${f.weekday.normal ? '#fde68a' : C.line};border-radius:8px;padding:10px 12px;margin-top:12px;line-height:1.5">
      <b>Wochentags-Einordnung:</b> ${f.weekday.normal
        ? `Für einen ${esc(f.weekday.name)} ist das allerdings nicht ungewöhnlich: An den letzten ${f.weekday.n} gleichen Wochentagen lag der Verbrauch im Schnitt bei ${fmt(f.weekday.avg)} kWh. Es könnte sich um ein normales Wochenmuster handeln.`
        : `Auch im Vergleich zu den letzten ${f.weekday.n} gleichen Wochentagen (${esc(f.weekday.name)}, Ø ${fmt(f.weekday.avg)} kWh) ist der Verbrauch erhöht (${Number.isFinite(f.weekday.deltaPct) ? '+' + fmt(f.weekday.deltaPct, 0) + ' %' : 'deutlich'}) – ein normales Wochenmuster erklärt es nicht.`}</div>` : '';
  const hours = f.metrics ? `<div style="font-size:15px;font-weight:700;color:${C.text};margin:22px 0 8px">Tagesverlauf: Wann wird Strom verbraucht?</div>${hourChart(f.metrics)}` : '';
  return `
  <tr><td style="padding:0 0 34px">
    <div style="font-size:12px;letter-spacing:.8px;text-transform:uppercase;color:${C.mute};font-weight:700">${title(f)}</div>
    <div style="font-size:20px;font-weight:800;color:${C.text};margin:2px 0 12px">${esc(f.label)}</div>
    <div style="background:${C.redSoft};border:1px solid #fecaca;border-radius:10px;padding:14px 16px;font-size:15px;color:#7f1d1d;line-height:1.5">${esc(sentence(f))}</div>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="8" style="margin:10px -8px 0;width:calc(100% + 16px)"><tr>
      <td width="33%" style="background:${C.soft};border:1px solid ${C.line};border-radius:8px;padding:12px"><div style="font-size:12px;color:${C.mute}">Verbrauch</div><div style="font-size:22px;font-weight:800;color:${C.text}">${fmt(f.current)}<span style="font-size:13px;font-weight:500;color:${C.mute}"> kWh/Tag</span></div></td>
      <td width="33%" style="background:${C.soft};border:1px solid ${C.line};border-radius:8px;padding:12px"><div style="font-size:12px;color:${C.mute}">Vergleich</div><div style="font-size:22px;font-weight:800;color:${C.text}">${fmt(f.reference)}<span style="font-size:13px;font-weight:500;color:${C.mute}"> kWh/Tag</span></div></td>
      <td width="33%" style="background:${C.redSoft};border:1px solid #fecaca;border-radius:8px;padding:12px"><div style="font-size:12px;color:${C.red}">Abweichung</div><div style="font-size:22px;font-weight:800;color:${C.red}">+${pctText(f)}</div></td>
    </tr></table>

    <div style="font-size:15px;font-weight:700;color:${C.text};margin:22px 0 8px">Warum bekomme ich diese E-Mail?</div>
    <div style="font-size:14px;color:#374151;line-height:1.55">${esc(f.rule.text)} Das entspricht <b>+${fmt(f.deltaKwh)} kWh pro Tag</b>. Die Prüfung läuft automatisch einmal täglich; Schwellen und Uhrzeit kannst du in den Einstellungen anpassen.</div>

    <div style="font-size:15px;font-weight:700;color:${C.text};margin:22px 0 8px">So sieht der Vergleich aus <span style="font-weight:400;color:${C.mute};font-size:12px">(${esc(f.unit)})</span></div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${barRows(f.series)}</table>

    <div style="font-size:15px;font-weight:700;color:${C.text};margin:22px 0 8px">Was ist auffällig?</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${causes}</table>
    ${wd}

    <div style="font-size:15px;font-weight:700;color:${C.text};margin:22px 0 8px">Kennzahlen im Vergleich</div>
    ${metricRows(f)}
    ${hours}

    <div style="font-size:15px;font-weight:700;color:${C.text};margin:22px 0 8px">Was kostet das?</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C.line};border-radius:8px;border-collapse:separate;font-size:14px">
      <tr><td style="padding:9px 12px;color:${C.mute}">Mehrkosten ${f.kind === 'day' ? 'gestern' : 'im Zeitraum bisher'}</td><td align="right" style="padding:9px 12px;font-weight:700;color:${C.red}">ca. ${fmt(f.extraCost)} ${cur}</td></tr>
      <tr><td style="padding:9px 12px;border-top:1px solid ${C.line};color:${C.mute}">Wenn es so bleibt: pro Monat</td><td align="right" style="padding:9px 12px;border-top:1px solid ${C.line}">ca. ${fmt(f.extraCostMonth)} ${cur} mehr</td></tr>
      <tr><td style="padding:9px 12px;border-top:1px solid ${C.line};color:${C.mute}">Wenn es so bleibt: pro Jahr</td><td align="right" style="padding:9px 12px;border-top:1px solid ${C.line}">ca. ${fmt(f.extraCostYear)} ${cur} mehr</td></tr>
      <tr><td style="padding:9px 12px;border-top:1px solid ${C.line};color:${C.mute}">Kosten pro Tag (aktuell)</td><td align="right" style="padding:9px 12px;border-top:1px solid ${C.line}">${fmt(f.cost)} ${cur} <span style="color:${C.mute}">bei ${fmt(f.price, 4)} ${cur}/kWh</span></td></tr>
    </table>
  </td></tr>`;
}

function buildAlertMail(findings, s, now = Date.now()) {
  const sub = findings.map((f) => `${f.kind === 'day' ? 'Tag' : 'Monat'} +${pctText(f)}`).join(', ');
  const subject = `Stromrechner: Erhöhter Verbrauch (${sub})`;
  const when = new Date(now).toLocaleString('de-DE', { dateStyle: 'full', timeStyle: 'short' });
  const cur = s.currency || '€';

  // Textfassung
  const t = ['STROMRECHNER – VERBRAUCHSWARNUNG', '='.repeat(36), ''];
  for (const f of findings) {
    t.push(`${title(f).toUpperCase()}: ${f.label}`, '-'.repeat(36), sentence(f), '',
      'WARUM BEKOMMST DU DIESE MAIL?', `${f.rule.text} Das sind +${fmt(f.deltaKwh)} kWh pro Tag.`, '',
      `VERGLEICH (${f.unit})`, ...f.series.map((x) => `  ${x.current ? '>' : ' '} ${x.label.padEnd(26)} ${fmt(x.kwh)} kWh`), '',
      'WAS IST AUFFÄLLIG?', ...f.causes.flatMap((c, i) => [`  ${i + 1}. ${c.title}`, `     ${c.text}`, `     Prüfen: ${c.tip}`]), '');
    if (f.weekday) t.push('WOCHENTAGS-EINORDNUNG', `  ${f.weekday.normal ? `Für einen ${f.weekday.name} nicht ungewöhnlich (Ø ${fmt(f.weekday.avg)} kWh an den letzten ${f.weekday.n} gleichen Wochentagen).` : `Auch gegenüber den letzten ${f.weekday.n} gleichen Wochentagen (${f.weekday.name}, Ø ${fmt(f.weekday.avg)} kWh) erhöht.`}`, '');
    if (f.metrics) {
      const m = f.metrics;
      t.push('KENNZAHLEN (aktuell / Vergleich)', `  Ø Leistung:   ${fmt(m.avgC, 0)} W / ${fmt(m.avgR, 0)} W`, `  Grundlast:    ${fmt(m.baseC, 0)} W / ${fmt(m.baseR, 0)} W`,
        `  Spitze:       ${fmt(m.peakC, 0)} W / ${fmt(m.peakR, 0)} W`, `  Aktive Zeit:  ${fmt(m.actC, 1)} h / ${fmt(m.actR, 1)} h pro Tag`, '');
    }
    t.push('KOSTEN', `  Mehrkosten ${f.kind === 'day' ? 'gestern' : 'bisher'}: ca. ${fmt(f.extraCost)} ${cur}`,
      `  Wenn es so bleibt: ca. ${fmt(f.extraCostMonth)} ${cur} pro Monat / ${fmt(f.extraCostYear)} ${cur} pro Jahr mehr`, '', '');
  }
  t.push(`Automatisch erstellt am ${when}. Regelbasierte Auswertung der Home-Assistant-Messwerte (Mittelwerte), keine KI.`);

  const html = `<!doctype html><html lang="de"><body style="margin:0;background:#f3f4f6;font-family:Segoe UI,Roboto,Arial,sans-serif;color:${C.text}">
  <div style="display:none;max-height:0;overflow:hidden">${esc(sentence(findings[0]))}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
  <table role="presentation" width="680" cellpadding="0" cellspacing="0" style="max-width:680px;width:100%;background:#fff;border-radius:12px;overflow:hidden;border:1px solid ${C.line}">
    <tr><td style="background:#0a0d13;padding:20px 28px;border-bottom:3px solid ${C.accent}">
      <div style="color:#fff;font-size:20px;font-weight:700">&#9889; Stromrechner</div>
      <div style="color:${C.accent};font-size:14px;margin-top:2px">Verbrauchswarnung · ${esc(sub)}</div></td></tr>
    <tr><td style="padding:28px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${findings.map((f) => card(f, s)).join('')}</table>
      <div style="font-size:12px;color:${C.gray};border-top:1px solid ${C.line};padding-top:14px;line-height:1.6">Automatisch erstellt am ${esc(when)}.<br>Regelbasierte Auswertung der Home-Assistant-Messwerte (Mittelwerte aus 5-Minuten- bzw. Stundenstatistik), keine KI. Die Prüfung läuft einmal täglich; Schwellen, Uhrzeit und Empfänger änderst du in den Einstellungen.</div></td></tr>
  </table></td></tr></table></body></html>`;
  return { subject, text: t.join('\n'), html };
}

function buildTestMail() {
  return {
    subject: 'Stromrechner: Testmail',
    text: 'Die SMTP-Verbindung funktioniert. Verbrauchswarnungen werden an diese Adresse gesendet.',
    html: '<div style="font-family:Segoe UI,Arial,sans-serif;padding:16px"><b>Stromrechner</b><p>Die SMTP-Verbindung funktioniert. Verbrauchswarnungen werden an diese Adresse gesendet.</p></div>',
  };
}

module.exports = { runChecks, buildAlertMail, buildTestMail, neededStart, diagnose };
