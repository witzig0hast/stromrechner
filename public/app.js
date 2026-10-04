'use strict';
const $ = (s, el = document) => el.querySelector(s);
const app = $('#app');
const nf = (n, d = 2) => Number(n).toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, opts = {}) {
  const method = opts.method || 'GET';
  const headers = { 'X-Requested-With': 'stromrechner' };
  if (opts.body) headers['Content-Type'] = 'application/json';
  const r = await fetch('/api' + path, { method, headers, body: opts.body ? JSON.stringify(opts.body) : undefined, credentials: 'same-origin' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Fehler ${r.status}`);
  return j;
}
const store = {
  get: (k, d) => { try { return localStorage.getItem('sr_' + k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem('sr_' + k, v); } catch { /* ignore */ } },
};
function toast(t) {
  const el = $('#toast'); el.textContent = t; el.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('show'), 2200);
}
const fmtDate = (s) => s ? new Date(s).toLocaleDateString('de-DE') : '–';
const fmtDT = (iso) => new Date(iso).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' });

/* ---------------- Dashboard ---------------- */
let refreshTimer = null;
const p2 = (n) => String(n).padStart(2, '0');
const dtLocal = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}`;
const PRESETS = [['all', 'Gesamt'], ['today', 'Heute'], ['7d', '7 Tage'], ['30d', '30 Tage'], ['month', 'Dieser Monat'], ['year', 'Dieses Jahr'], ['custom', 'Eigener Zeitraum']];
function presetRange(id, custom) {
  const n = new Date(), d0 = new Date(n.getFullYear(), n.getMonth(), n.getDate());
  const off = (days) => dtLocal(new Date(d0.getFullYear(), d0.getMonth(), d0.getDate() - days));
  if (id === 'all') return { start: 'all', end: '' };
  if (id === 'today') return { start: dtLocal(d0), end: '' };
  if (id === '7d') return { start: off(6), end: '' };
  if (id === '30d') return { start: off(29), end: '' };
  if (id === 'month') return { start: dtLocal(new Date(n.getFullYear(), n.getMonth(), 1)), end: '' };
  if (id === 'year') return { start: dtLocal(new Date(n.getFullYear(), 0, 1)), end: '' };
  return custom;
}

async function dashboard() {
  const [s, hist] = await Promise.all([api('/settings'), api('/history')]);
  const cur = s.currency;
  const configured = s.hasToken && s.haUrl && s.entityPower;
  let preset = store.get('preset', 'all');
  if (!PRESETS.some(([id]) => id === preset)) preset = 'all';
  const savedRef = store.get('ref', '');
  app.innerHTML = `
    <div class="head"><h1>Auswertung</h1>
    <p class="sub">Verbrauch und Kosten deiner Steckdose aus Home Assistant.</p></div>
    <section class="card"><div class="card-b bar-row">
      <div class="chips" role="tablist" aria-label="Zeitraum">${PRESETS.map(([id, l]) => `<button class="chip${id === preset ? ' on' : ''}" data-p="${id}" role="tab">${l}</button>`).join('')}</div>
      <div class="cmp"><label for="ref">Vergleich mit Gesamtverbrauch</label>
        <select id="ref"><option value="">– kein Vergleich –</option>
          ${hist.map((h) => `<option value="${h.kwh}">${esc(h.label)} · ${nf(h.kwh, 0)} kWh</option>`).join('')}
          <option value="custom">Eigener Wert …</option></select></div>
      <button class="btn ghost sm" id="go" title="Neu laden">Aktualisieren</button>
    </div>
    <div class="card-b custom" id="customBox" ${preset === 'custom' ? '' : 'hidden'}>
      <div class="row">
        <div><label for="start">Start</label><input type="datetime-local" id="start" value="${esc(s.measureStart)}"></div>
        <div><label for="end">Ende (leer = läuft weiter)</label><input type="datetime-local" id="end" value="${esc(s.measureEnd)}"></div>
        <div id="customWrap" hidden><label for="custom">Gesamt kWh</label><input id="custom" inputmode="decimal" placeholder="z. B. 2850"></div>
        <button class="btn ghost sm" id="saveRange">Als Standard speichern</button>
      </div>
    </div>
    <div class="card-b" id="status" hidden></div></section>
    <div id="out"></div>`;

  const ref = $('#ref');
  if ([...ref.options].some((o) => o.value === savedRef)) ref.value = savedRef;
  $('#customWrap').hidden = ref.value !== 'custom';

  const status = (html) => { const el = $('#status'); el.hidden = !html; el.innerHTML = html || ''; };
  let seq = 0;
  const run = async (quiet) => {
    const my = ++seq;
    const range = presetRange(preset, { start: $('#start').value, end: $('#end').value });
    if (!configured) {
      $('#out').innerHTML = `<section class="card"><div class="card-b empty-state"><h2>Home Assistant verbinden</h2><p class="sub">Trage in den Einstellungen die URL, den Zugriffstoken und die Leistungs-Entität deiner Steckdose ein, dann erscheint hier sofort deine Auswertung.</p><a class="btn" href="#/settings">Zu den Einstellungen</a></div></section>`;
      return;
    }
    if (!range.start) { status('<div class="msg warn">Bitte einen Start wählen.</div>'); return; }
    const refKwh = ref.value === 'custom' ? $('#custom').value.replace(',', '.') : ref.value;
    if (!quiet) { $('#out').classList.add('loading'); status('<div class="msg ok"><span class="spin"></span>Lade Daten aus Home Assistant …</div>'); }
    try {
      const r = await api('/calc?' + new URLSearchParams({ start: range.start, end: range.end, refKwh: refKwh || 0 }));
      if (my !== seq) return;
      status((r.rangeNote ? `<div class="msg warn">${esc(r.rangeNote)}</div>` : '') + (r.coverage < 0.98 ? `<div class="msg warn">Nur ${nf(r.coverage * 100, 0)} % des Zeitraums (${nf(r.coveredHours, 1)} von ${nf(r.hours, 1)} Std.) haben Messwerte. Durchschnitt, Kosten pro Tag und Hochrechnung beziehen sich auf die gemessene Zeit.</div>` : ''));
      render(r, cur);
    } catch (e) {
      if (my !== seq) return;
      status(`<div class="msg err">${esc(e.message)}</div>`); $('#out').innerHTML = '';
    } finally { $('#out').classList.remove('loading'); }
  };

  app.querySelectorAll('.chip').forEach((b) => b.onclick = () => {
    preset = b.dataset.p; store.set('preset', preset);
    app.querySelectorAll('.chip').forEach((x) => x.classList.toggle('on', x === b));
    $('#customBox').hidden = preset !== 'custom';
    run();
  });
  ref.onchange = () => { store.set('ref', ref.value); $('#customWrap').hidden = ref.value !== 'custom'; $('#customBox').hidden = preset !== 'custom' && ref.value !== 'custom'; run(); };
  let deb; const later = () => { clearTimeout(deb); deb = setTimeout(run, 500); };
  ['start', 'end', 'custom'].forEach((id) => { $('#' + id).onchange = later; });
  $('#go').onclick = () => run();
  $('#saveRange').onclick = async () => {
    await api('/settings', { method: 'PUT', body: { measureStart: $('#start').value, measureEnd: $('#end').value } });
    toast('Zeitraum gespeichert');
  };
  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => { if (!document.hidden && !presetRange(preset, { start: $('#start').value, end: $('#end').value }).end) run(true); }, 60000);
  await run();
}

const ICON = {
  euro: '<path d="M18 7a7 7 0 1 0 0 10M4 10h10M4 14h10"/>',
  bolt: '<path d="M13 2 4 14h6l-1 8 9-12h-6z"/>',
  gauge: '<path d="M12 14l4-4"/><path d="M3.3 17a10 10 0 1 1 17.4 0"/>',
  peak: '<path d="M3 18l6-9 4 5 3-4 5 8z"/>',
  volt: '<path d="M2 12h4l3-8 6 16 3-8h4"/>',
  amp: '<circle cx="12" cy="12" r="9"/><path d="M8 16l4-8 4 8M9.5 13.5h5"/>',
  cal: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18"/>',
  trend: '<path d="M3 17l6-6 4 4 8-8M15 7h6v6"/>',
};
const ico = (n) => `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICON[n]}</svg>`;

function render(r, cur) {
  const k = (cls, icon, label, v, unit) => `<div class="kpi ${cls}"><small>${ico(icon)}${label}</small><div class="v">${v}<em>${unit}</em></div></div>`;
  const pct = r.percent !== undefined ? `
    <section class="card"><div class="card-h"><div><h2>Anteil am Gesamtverbrauch</h2><p>Vergleich mit dem gewählten Gesamtwert.</p></div></div>
      <div class="card-b"><div class="grid g3">
        ${k('cy', 'gauge', 'Anteil der Steckdose', nf(r.percent, 1), '%')}
        ${k('', 'bolt', 'Steckdose', nf(r.kwh), 'kWh')}
        ${k('', 'bolt', 'Gesamtverbrauch', nf(r.refKwh), 'kWh')}
      </div>
      <div class="bar"><i data-w="${Math.min(100, r.percent)}"></i></div>
      <div class="hint">Die Steckdose entspricht ${nf(r.cost)} ${cur} von insgesamt ca. ${nf(r.refCost)} ${cur}.</div></div>
    </section>` : '';
  $('#out').innerHTML = `
    <section class="card">
      <div class="card-h"><div><h2>Ergebnis</h2><p>Preis ${nf(r.pricePerKwh, 4)} ${cur}/kWh · ${nf(r.coveredHours, 1)} Std. gemessen von ${nf(r.hours, 1)} Std.</p></div>
        <span class="tag ${r.open ? 'live' : ''}">${fmtDT(r.start)} – ${r.open ? 'jetzt (läuft)' : fmtDT(r.end)}</span></div>
      <div class="card-b"><div class="grid g4">
        ${k('hero', 'euro', 'Kosten', nf(r.cost), cur)}
        ${k('', 'bolt', 'Verbrauch', nf(r.kwh, 3), 'kWh')}
        ${k('', 'gauge', 'Ø Leistung (gemessen)', nf(r.avgWatt, 1), 'W')}
        ${k('', 'peak', 'Spitzenleistung', nf(r.peakWatt, 0), 'W')}
        ${r.avgVolt !== null ? k('cy', 'volt', 'Ø Spannung', nf(r.avgVolt, 1), 'V') : ''}
        ${r.avgAmpere !== null ? k('cy', 'amp', 'Ø Stromstärke', nf(r.avgAmpere, 3), 'A') : ''}
        ${k('', 'cal', 'Kosten pro Tag', nf(r.costPerDay), cur)}
        ${k('', 'trend', 'Hochrechnung / Jahr', nf(r.projectedYearCost, 0), cur)}
      </div>
      <div class="hint">Datenbasis: ${r.source === 'statistics' ? 'Mittelwerte der Home-Assistant-Statistik (5 Minuten, ältere Daten stündlich)' : 'Zustandsverlauf (keine Statistik für diese Entität vorhanden)'}. Jahreshochrechnung: ca. ${nf(r.projectedYearKwh, 0)} kWh.</div></div>
    </section>
    ${pct}
    ${r.days.length > 92 ? `<section class="card"><div class="card-h"><h2>Verbrauch pro Monat</h2><span class="tag">kWh</span></div><div class="card-b">${chart(monthRows(r.days))}</div></section>` : ''}
    ${r.days.length > 31 ? `<section class="card"><div class="card-h"><h2>Monatsübersicht</h2></div><div class="card-b"><div class="tbl tall"><table><thead><tr><th>Monat</th><th class="r">Tage</th><th class="r">kWh</th><th class="r">Ø kWh/Tag</th><th class="r">Kosten</th></tr></thead><tbody>${monthRows(r.days).reverse().map((m) => `<tr><td>${esc(m.title)}</td><td class="r">${m.days}</td><td class="r">${nf(m.kwh, 2)}</td><td class="r">${nf(m.kwh / m.days, 2)}</td><td class="r">${nf(m.cost)} ${cur}</td></tr>`).join('')}</tbody></table></div></div></section>` : ''}
    <section class="card"><div class="card-h"><h2>Verbrauch pro Tag${r.days.length > 92 ? ' (letzte 90 Tage)' : ''}</h2><span class="tag">kWh</span></div><div class="card-b">${chart(dayItems(r.days.slice(-90)))}</div></section>
    <section class="card"><div class="card-h"><h2>Tagesübersicht</h2></div><div class="card-b">
      <div class="tbl tall"><table><thead><tr><th>Datum</th><th class="r">kWh</th><th class="r">Kosten</th></tr></thead><tbody>
      ${[...r.days].reverse().map((d) => `<tr><td>${fmtDate(d.date)}</td><td class="r">${nf(d.kwh, 3)}</td><td class="r">${nf(d.cost)} ${cur}</td></tr>`).join('')}
      </tbody></table></div></div></section>`;
  $('#out').querySelectorAll('[data-w]').forEach((e) => { e.style.width = e.dataset.w + '%'; });
}

function chart(items) {
  if (!items.length) return '';
  const W = 1000, H = 240, pl = 44, pb = 26, pt = 10;
  const max = Math.max(...items.map((d) => d.kwh), 0.001);
  const bw = (W - pl) / items.length;
  const gap = Math.min(4, bw * 0.2);
  const grid = [0, .25, .5, .75, 1].map((f) => {
    const y = pt + (H - pt - pb) * (1 - f);
    return `<line x1="${pl}" x2="${W}" y1="${y}" y2="${y}"/><text x="${pl - 6}" y="${y + 4}" text-anchor="end">${nf(max * f, max < 1 ? 2 : 1)}</text>`;
  }).join('');
  const step = Math.ceil(items.length / 12);
  const bars = items.map((d, i) => {
    const h = (H - pt - pb) * (d.kwh / max), x = pl + i * bw + gap / 2;
    const lbl = i % step === 0 ? `<text x="${x + (bw - gap) / 2}" y="${H - 8}" text-anchor="middle">${esc(d.label)}</text>` : '';
    return `<rect class="bar-r" x="${x}" y="${H - pb - h}" width="${Math.max(1, bw - gap)}" height="${h}" rx="2"><title>${esc(d.title)}: ${nf(d.kwh, 3)} kWh</title></rect>${lbl}`;
  }).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${grid}${bars}</svg>`;
}
const dayItems = (days) => days.map((d) => ({ kwh: d.kwh, label: `${d.date.slice(8)}.${d.date.slice(5, 7)}.`, title: fmtDate(d.date) }));
function monthRows(days) {
  const m = new Map();
  for (const d of days) {
    const k = d.date.slice(0, 7), r = m.get(k) || { key: k, kwh: 0, cost: 0, days: 0 };
    r.kwh += d.kwh; r.cost += d.cost; r.days += 1; m.set(k, r);
  }
  return [...m.values()].map((r) => ({ ...r, title: new Date(r.key + '-01T12:00').toLocaleDateString('de-DE', { month: 'long', year: 'numeric' }), label: `${r.key.slice(5)}/${r.key.slice(2, 4)}` }));
}

/* ---------------- Einstellungen ---------------- */
async function settings() {
  const [s, hist, al] = await Promise.all([api('/settings'), api('/history'), api('/alerts')]);
  app.innerHTML = `
    <div class="head"><h1>Einstellungen</h1>
    <p class="sub">Strompreis, Home-Assistant-Anbindung und frühere Verbrauchswerte verwalten.</p></div>

    <section class="card"><div class="card-h"><div><h2>Strompreis</h2><p>Grundlage für die Kostenberechnung.</p></div></div><div class="card-b">
      <div class="row">
        <div><label for="price">Preis pro kWh (${esc(s.currency)})</label><input id="price" inputmode="decimal" value="${s.pricePerKwh}"></div>
        <div><label for="base">Grundgebühr pro Jahr (${esc(s.currency)}), optional</label><input id="base" inputmode="decimal" value="${s.basePriceYear}"></div>
        <button class="btn" id="savePrice">Speichern</button>
      </div></div>
    </section>

    <section class="card"><div class="card-h"><div><h2>Home Assistant</h2><p>Zugang und Entitäten der Messsteckdose.</p></div></div><div class="card-b">
      <div class="grid g2">
        <div><label for="url">URL</label><input id="url" placeholder="http://homeassistant.local:8123" value="${esc(s.haUrl)}"></div>
        <div><label for="token">Long-Lived Access Token</label><input id="token" type="password" autocomplete="off" placeholder="${s.hasToken ? '•••••••• gespeichert (leer lassen zum Behalten)' : 'Token einfügen'}"></div>
        <div><label for="ep">Entität Leistung (W)</label><input id="ep" placeholder="sensor.steckdose_power" value="${esc(s.entityPower)}"></div>
        <div><label for="ev">Entität Spannung (V), optional</label><input id="ev" placeholder="sensor.steckdose_voltage" value="${esc(s.entityVoltage)}"></div>
        <div><label for="ec">Entität Stromstärke (A), optional</label><input id="ec" placeholder="sensor.steckdose_current" value="${esc(s.entityCurrent)}"></div>
      </div>
      <div class="actions"><button class="btn" id="saveHa">Speichern</button><button class="btn ghost" id="testHa">Verbindung testen</button></div>
      <div class="hint">Token erstellen: Home Assistant → Profil → Sicherheit → Langlebige Zugriffstoken. Der Verbrauch wird aus der Leistung (W) über die Zeit berechnet.</div>
      <div id="haStatus"></div></div>
    </section>

    <section class="card"><div class="card-h"><div><h2>E-Mail-Benachrichtigung</h2><p>Warnt, wenn der Verbrauch gegenüber den Vortagen oder Vormonaten deutlich steigt, inklusive Ursachenanalyse. Versand per SMTP mit direktem TLS (Port 465).</p></div></div><div class="card-b">
      <div class="grid g2">
        <div><label for="sh">SMTP-Server</label><input id="sh" placeholder="smtp.example.com" value="${esc(s.smtpHost)}"></div>
        <div><label for="sp">Port (direktes TLS)</label><input id="sp" inputmode="numeric" value="${s.smtpPort}"></div>
        <div><label for="su">Benutzername</label><input id="su" autocomplete="off" value="${esc(s.smtpUser)}"></div>
        <div><label for="spw">Passwort</label><input id="spw" type="password" autocomplete="new-password" placeholder="${s.hasSmtpPass ? '•••••••• gespeichert (leer lassen zum Behalten)' : 'Passwort'}"></div>
        <div><label for="sf">Absender</label><input id="sf" placeholder="stromrechner@example.com" value="${esc(s.smtpFrom)}"></div>
        <div><label for="st">Empfänger (mehrere mit Komma)</label><input id="st" placeholder="du@example.com" value="${esc(s.smtpTo)}"></div>
      </div>
      <label class="check"><input type="checkbox" id="sv" ${s.smtpVerify ? 'checked' : ''}> TLS-Zertifikat des Servers prüfen (nur bei selbstsigniertem Zertifikat abschalten)</label>
      <div class="sep"></div>
      <div class="grid g4">
        <div><label for="at">Tägliche Prüfung um</label><input type="time" id="at" value="${esc(s.alertTime)}"></div>
        <div><label for="ad">Schwelle Tag (+ %)</label><input id="ad" inputmode="decimal" value="${s.alertDayPct}"></div>
        <div><label for="am">Schwelle Monat (+ %)</label><input id="am" inputmode="decimal" value="${s.alertMonthPct}"></div>
        <div><label for="ak">Mindest-Mehrverbrauch (kWh/Tag)</label><input id="ak" inputmode="decimal" value="${s.alertMinKwh}"></div>
      </div>
      <label class="check"><input type="checkbox" id="ae" ${s.alertsEnabled ? 'checked' : ''}> Automatische tägliche Prüfung aktivieren (E-Mail nur bei Auffälligkeit)</label>
      <div class="hint">Tag: gestern gegen den Durchschnitt der 7 Tage davor. Monat: laufender Monat (an den ersten beiden Tagen der Vormonat) gegen den Durchschnitt der 3 Monate davor.</div>
      <div class="actions"><button class="btn" id="saveMail">Speichern</button><button class="btn ghost" id="testMail">Testmail senden</button><button class="btn ghost" id="checkNow">Jetzt prüfen (Vorschau)</button><button class="btn ghost" id="checkSend">Prüfen &amp; E-Mail senden</button></div>
      ${al.state.lastError ? `<div class="msg err">Letzter automatischer Versand fehlgeschlagen: ${esc(al.state.lastError)}</div>` : ''}
      <div id="mailStatus"></div>
      ${al.log.length ? `<div class="tbl mid"><table><thead><tr><th>Gesendet</th><th>Art</th><th>Zeitraum</th><th class="r">Abweichung</th></tr></thead><tbody>${al.log.map((a) => `<tr><td>${fmtDT(a.at)}</td><td>${a.kind === 'day' ? 'Tag' : 'Monat'}</td><td>${esc(a.label)}</td><td class="r">${a.deltaPct === null ? '–' : '+' + nf(a.deltaPct, 0) + ' %'}</td></tr>`).join('')}</tbody></table></div>` : ''}
    </div></section>

    <section class="card"><div class="card-h"><div><h2>Frühere Ergebnisse</h2><p>Gesamtverbrauch vergangener Zeiträume, nutzbar als Vergleichswert.</p></div></div><div class="card-b">
      <div class="row">
        <div><label for="hl">Bezeichnung</label><input id="hl" placeholder="z. B. Abrechnung 2025"></div>
        <div><label for="hf">Von</label><input type="date" id="hf"></div>
        <div><label for="ht">Bis</label><input type="date" id="ht"></div>
        <div><label for="hk">Verbrauch (kWh)</label><input id="hk" inputmode="decimal"></div>
        <button class="btn" id="addH">Hinzufügen</button>
      </div>
      <div id="hErr"></div>
      <div class="tbl top"><table><thead><tr><th>Bezeichnung</th><th>Zeitraum</th><th class="r">kWh</th><th class="r">Kosten (aktueller Preis)</th><th></th></tr></thead><tbody>
      ${hist.length ? hist.map((h) => `<tr><td>${esc(h.label)}</td><td>${h.from || h.to ? `${fmtDate(h.from)} – ${fmtDate(h.to)}` : '–'}</td><td class="r">${nf(h.kwh, 0)}</td><td class="r">${nf(h.kwh * s.pricePerKwh)} ${esc(s.currency)}</td><td class="r"><button class="btn danger sm" data-del="${h.id}">Löschen</button></td></tr>`).join('') : '<tr><td colspan="5" class="empty">Noch keine Einträge.</td></tr>'}
      </tbody></table></div></div>
    </section>`;

  $('#savePrice').onclick = async () => {
    await api('/settings', { method: 'PUT', body: { pricePerKwh: $('#price').value, basePriceYear: $('#base').value } });
    toast('Preis gespeichert'); settings();
  };
  const haBody = () => ({ haUrl: $('#url').value, haToken: $('#token').value, entityPower: $('#ep').value, entityVoltage: $('#ev').value, entityCurrent: $('#ec').value });
  $('#saveHa').onclick = async () => { await api('/settings', { method: 'PUT', body: haBody() }); toast('Gespeichert'); $('#token').value = ''; };
  $('#testHa').onclick = async () => {
    const st = $('#haStatus'); st.innerHTML = '<div class="msg ok"><span class="spin"></span>Teste …</div>';
    const r = await api('/ha/test', { method: 'POST', body: haBody() }).catch((e) => ({ ok: false, error: e.message }));
    if (!r.ok) { st.innerHTML = `<div class="msg err">${esc(r.error)}</div>`; return; }
    const names = { power: 'Leistung', voltage: 'Spannung', current: 'Stromstärke' };
    const lines = Object.entries(r.entities).map(([k, v]) => v.ok ? `✔ ${names[k]}: ${esc(v.state)} ${esc(v.unit)}` : `✖ ${names[k]}: ${esc(v.error)}`);
    const bad = Object.values(r.entities).some((v) => !v.ok);
    st.innerHTML = `<div class="msg ${bad ? 'err' : 'ok'}">Verbindung steht.${lines.length ? '<br>' + lines.join('<br>') : ''}</div>`;
  };
  const mailBody = () => ({ smtpHost: $('#sh').value, smtpPort: $('#sp').value, smtpUser: $('#su').value, smtpPass: $('#spw').value, smtpFrom: $('#sf').value, smtpTo: $('#st').value, smtpVerify: $('#sv').checked });
  const saveMail = () => api('/settings', { method: 'PUT', body: { ...mailBody(), alertsEnabled: $('#ae').checked, alertTime: $('#at').value, alertDayPct: $('#ad').value, alertMonthPct: $('#am').value, alertMinKwh: $('#ak').value } });
  const ms = $('#mailStatus');
  $('#saveMail').onclick = async () => { await saveMail(); $('#spw').value = ''; toast('Gespeichert'); };
  $('#testMail').onclick = async () => {
    ms.innerHTML = '<div class="msg ok"><span class="spin"></span>Sende Testmail …</div>';
    const r = await api('/mail/test', { method: 'POST', body: mailBody() }).catch((e) => ({ ok: false, error: e.message }));
    ms.innerHTML = r.ok ? '<div class="msg ok">Testmail wurde gesendet.</div>' : `<div class="msg err">${esc(r.error)}</div>`;
  };
  const runCheck = (send) => async () => {
    await saveMail(); $('#spw').value = '';
    ms.innerHTML = '<div class="msg ok"><span class="spin"></span>Prüfe Verbrauch …</div>';
    try {
      const r = await api('/alerts/check', { method: 'POST', body: { send } });
      const st = { alert: ['err', 'Auffällig'], ok: ['ok', 'Unauffällig'], skipped: ['warn', 'Übersprungen'] };
      let h = r.checks.map((c) => `<div class="msg ${st[c.status][0]}"><b>${esc(c.title)}: ${st[c.status][1]}</b><br>${c.current !== undefined ? `${esc(c.label)}: ${nf(c.current)} kWh/Tag · Vergleich ${nf(c.reference)} kWh/Tag (${esc(c.refLabel)}) · ${Number.isFinite(c.deltaPct) ? (c.deltaPct >= 0 ? '+' : '') + nf(c.deltaPct, 0) + ' %' : 'neu'}<br>` : ''}${esc(c.note)}</div>`).join('');
      r.findings.forEach((f) => { h += `<div class="msg warn"><b>Mögliche Ursachen (${f.kind === 'day' ? 'Tag' : 'Monat'}):</b><ul>${f.causes.map((c) => `<li><b>${esc(c.title)}.</b> ${esc(c.text)}<br><span class="hint">Prüfen: ${esc(c.tip)}</span></li>`).join('')}</ul></div>`; });
      if (send) h += r.sent ? '<div class="msg ok">E-Mail wurde gesendet.</div>' : r.error ? `<div class="msg err">Versand fehlgeschlagen: ${esc(r.error)}</div>` : '<div class="msg ok">Keine Auffälligkeit – es wurde keine E-Mail gesendet.</div>';
      ms.innerHTML = h;
      if (r.sent) setTimeout(settings, 2500);
    } catch (e) { ms.innerHTML = `<div class="msg err">${esc(e.message)}</div>`; }
  };
  $('#checkNow').onclick = runCheck(false);
  $('#checkSend').onclick = runCheck(true);
  $('#addH').onclick = async () => {
    try {
      await api('/history', { method: 'POST', body: { label: $('#hl').value, from: $('#hf').value, to: $('#ht').value, kwh: $('#hk').value } });
      toast('Eintrag hinzugefügt'); settings();
    } catch (e) { $('#hErr').innerHTML = `<div class="msg err">${esc(e.message)}</div>`; }
  };
  app.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => {
    if (!confirm('Eintrag löschen?')) return;
    await api('/history/' + b.dataset.del, { method: 'DELETE' }); settings();
  });
}

/* ---------------- Router ---------------- */
async function route() {
  clearInterval(refreshTimer);
  const page = location.hash.startsWith('#/settings') ? 'settings' : 'dash';
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('on', a.dataset.nav === page));
  try { await (page === 'settings' ? settings() : dashboard()); }
  catch (e) { app.innerHTML = `<div class="msg err">${esc(e.message)}</div>`; }
}
addEventListener('hashchange', route);
route();
