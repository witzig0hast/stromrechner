'use strict';
const $ = (s, el = document) => el.querySelector(s);
const app = $('#app');
const nf = (n, d = 2) => Number(n).toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, opts = {}) {
  const r = await fetch('/api' + path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Fehler ${r.status}`);
  return j;
}
function toast(t) {
  const el = $('#toast'); el.textContent = t; el.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('show'), 2200);
}
const fmtDate = (s) => s ? new Date(s).toLocaleDateString('de-DE') : '–';
const fmtDT = (iso) => new Date(iso).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' });

/* ---------------- Dashboard ---------------- */
async function dashboard() {
  const [s, hist] = await Promise.all([api('/settings'), api('/history')]);
  const cur = s.currency;
  app.innerHTML = `
    <div class="head"><h1>Auswertung</h1>
    <p class="sub">Verbrauch und Kosten deiner Steckdose aus Home Assistant für einen frei wählbaren Zeitraum.</p></div>
    <section class="card">
      <div class="card-h"><div><h2>Zeitraum &amp; Vergleich</h2><p>Messzeitraum festlegen und optional mit dem Gesamtverbrauch vergleichen.</p></div></div>
      <div class="card-b"><div class="row">
        <div><label for="start">Start</label><input type="datetime-local" id="start" value="${esc(s.measureStart)}"></div>
        <div><label for="end">Ende (leer = läuft weiter)</label><input type="datetime-local" id="end" value="${esc(s.measureEnd)}"></div>
        <div><label for="ref">Gesamtverbrauch (Vergleich)</label>
          <select id="ref"><option value="">– kein Vergleich –</option>
            ${hist.map((h) => `<option value="${h.kwh}">${esc(h.label)} · ${nf(h.kwh, 0)} kWh</option>`).join('')}
            <option value="custom">Eigener Wert …</option></select></div>
        <div id="customWrap" hidden><label for="custom">Gesamt kWh</label><input id="custom" inputmode="decimal" placeholder="z. B. 2850"></div>
        <button class="btn" id="go">Berechnen</button>
      </div>
      <div class="actions"><button class="btn ghost sm" id="saveRange">Zeitraum als Standard speichern</button></div>
      <div id="status"></div></div>
    </section>
    <div id="out"></div>`;

  const ref = $('#ref');
  ref.onchange = () => { $('#customWrap').hidden = ref.value !== 'custom'; };
  $('#saveRange').onclick = async () => {
    await api('/settings', { method: 'PUT', body: { measureStart: $('#start').value, measureEnd: $('#end').value } });
    toast('Zeitraum gespeichert');
  };
  const run = async () => {
    const start = $('#start').value, end = $('#end').value;
    let refKwh = ref.value === 'custom' ? $('#custom').value.replace(',', '.') : ref.value;
    const btn = $('#go'), st = $('#status');
    if (!start) { st.innerHTML = '<div class="msg warn">Bitte ein Startdatum wählen.</div>'; return; }
    btn.disabled = true; st.innerHTML = '<div class="msg ok"><span class="spin"></span>Lade Daten aus Home Assistant …</div>';
    try {
      const q = new URLSearchParams({ start, end, refKwh: refKwh || 0 });
      const r = await api('/calc?' + q);
      st.innerHTML = r.coverage < 0.5 ? `<div class="msg warn">Nur ${nf(r.coverage * 100, 0)} % des Zeitraums haben Messwerte – Ergebnis ist vermutlich unvollständig.</div>` : '';
      render(r, cur);
    } catch (e) {
      st.innerHTML = `<div class="msg err">${esc(e.message)}</div>`; $('#out').innerHTML = '';
    } finally { btn.disabled = false; }
  };
  $('#go').onclick = run;
  if (s.measureStart && s.hasToken) run();
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
      <div class="bar"><i style="width:${Math.min(100, r.percent)}%"></i></div>
      <div class="hint">Die Steckdose entspricht ${nf(r.cost)} ${cur} von insgesamt ca. ${nf(r.refCost)} ${cur}.</div></div>
    </section>` : '';
  $('#out').innerHTML = `
    <section class="card">
      <div class="card-h"><div><h2>Ergebnis</h2><p>Preis ${nf(r.pricePerKwh, 4)} ${cur}/kWh · ${nf(r.hours / 24, 1)} Tage</p></div>
        <span class="tag ${r.open ? 'live' : ''}">${fmtDT(r.start)} – ${r.open ? 'jetzt (läuft)' : fmtDT(r.end)}</span></div>
      <div class="card-b"><div class="grid g4">
        ${k('hero', 'euro', 'Kosten', nf(r.cost), cur)}
        ${k('', 'bolt', 'Verbrauch', nf(r.kwh, 3), 'kWh')}
        ${k('', 'gauge', 'Ø Leistung', nf(r.avgWatt, 1), 'W')}
        ${k('', 'peak', 'Spitzenleistung', nf(r.peakWatt, 0), 'W')}
        ${r.avgVolt !== null ? k('cy', 'volt', 'Ø Spannung', nf(r.avgVolt, 1), 'V') : ''}
        ${r.avgAmpere !== null ? k('cy', 'amp', 'Ø Stromstärke', nf(r.avgAmpere, 3), 'A') : ''}
        ${k('', 'cal', 'Kosten pro Tag', nf(r.costPerDay), cur)}
        ${k('', 'trend', 'Hochrechnung / Jahr', nf(r.projectedYearCost, 0), cur)}
      </div>
      <div class="hint">Datenbasis: ${r.source === 'statistics' ? 'Mittelwerte der Home-Assistant-Statistik (5 Minuten, ältere Daten stündlich)' : 'Zustandsverlauf (keine Statistik für diese Entität vorhanden)'}. Jahreshochrechnung: ca. ${nf(r.projectedYearKwh, 0)} kWh.</div></div>
    </section>
    ${pct}
    <section class="card"><div class="card-h"><h2>Verbrauch pro Tag</h2><span class="tag">kWh</span></div><div class="card-b">${chart(r.days)}</div></section>
    <section class="card"><div class="card-h"><h2>Tagesübersicht</h2></div><div class="card-b">
      <div class="tbl" style="max-height:360px"><table><thead><tr><th>Datum</th><th class="r">kWh</th><th class="r">Kosten</th></tr></thead><tbody>
      ${[...r.days].reverse().map((d) => `<tr><td>${fmtDate(d.date)}</td><td class="r">${nf(d.kwh, 3)}</td><td class="r">${nf(d.cost)} ${cur}</td></tr>`).join('')}
      </tbody></table></div></div></section>`;
}

function chart(days) {
  if (!days.length) return '';
  const W = 1000, H = 240, pl = 44, pb = 26, pt = 10;
  const max = Math.max(...days.map((d) => d.kwh), 0.001);
  const bw = (W - pl) / days.length;
  const gap = Math.min(4, bw * 0.2);
  const grid = [0, .25, .5, .75, 1].map((f) => {
    const y = pt + (H - pt - pb) * (1 - f);
    return `<line x1="${pl}" x2="${W}" y1="${y}" y2="${y}"/><text x="${pl - 6}" y="${y + 4}" text-anchor="end">${nf(max * f, max < 1 ? 2 : 1)}</text>`;
  }).join('');
  const step = Math.ceil(days.length / 12);
  const bars = days.map((d, i) => {
    const h = (H - pt - pb) * (d.kwh / max), x = pl + i * bw + gap / 2;
    const lbl = i % step === 0 ? `<text x="${x + (bw - gap) / 2}" y="${H - 8}" text-anchor="middle">${d.date.slice(8)}.${d.date.slice(5, 7)}.</text>` : '';
    return `<rect class="bar-r" x="${x}" y="${H - pb - h}" width="${Math.max(1, bw - gap)}" height="${h}" rx="2"><title>${fmtDate(d.date)}: ${nf(d.kwh, 3)} kWh</title></rect>${lbl}`;
  }).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${grid}${bars}</svg>`;
}

/* ---------------- Einstellungen ---------------- */
async function settings() {
  const [s, hist] = await Promise.all([api('/settings'), api('/history')]);
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

    <section class="card"><div class="card-h"><div><h2>Frühere Ergebnisse</h2><p>Gesamtverbrauch vergangener Zeiträume, nutzbar als Vergleichswert.</p></div></div><div class="card-b">
      <div class="row">
        <div><label for="hl">Bezeichnung</label><input id="hl" placeholder="z. B. Abrechnung 2025"></div>
        <div><label for="hf">Von</label><input type="date" id="hf"></div>
        <div><label for="ht">Bis</label><input type="date" id="ht"></div>
        <div><label for="hk">Verbrauch (kWh)</label><input id="hk" inputmode="decimal"></div>
        <button class="btn" id="addH">Hinzufügen</button>
      </div>
      <div id="hErr"></div>
      <div class="tbl" style="margin-top:18px"><table><thead><tr><th>Bezeichnung</th><th>Zeitraum</th><th class="r">kWh</th><th class="r">Kosten (aktueller Preis)</th><th></th></tr></thead><tbody>
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
  const page = location.hash.startsWith('#/settings') ? 'settings' : 'dash';
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('on', a.dataset.nav === page));
  try { await (page === 'settings' ? settings() : dashboard()); }
  catch (e) { app.innerHTML = `<div class="msg err">${esc(e.message)}</div>`; }
}
addEventListener('hashchange', route);
route();
