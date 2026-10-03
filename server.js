'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DAY, nextDay, dayStart, dayKey, integrate, parseHistory, normalizeUrl } = require('./lib');

const PORT = Number(process.env.PORT) || 8723;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PUBLIC = path.join(__dirname, 'public');

const DEFAULTS = {
  settings: {
    pricePerKwh: 0.35,       // €/kWh
    basePriceYear: 0,        // optional Grundgebühr €/Jahr (nur Info)
    currency: '€',
    haUrl: '',
    haToken: '',
    entityPower: '',
    entityVoltage: '',
    entityCurrent: '',
    measureStart: '',
    measureEnd: '',
  },
  history: [],
};

fs.mkdirSync(DATA_DIR, { recursive: true });
let db = structuredClone(DEFAULTS);
try {
  const saved = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  db = { settings: { ...DEFAULTS.settings, ...saved.settings }, history: saved.history || [] };
} catch { /* first start */ }

function save() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

/* ---------- Home Assistant ---------- */

async function haFetch(url, token, p, timeoutMs = 30000) {
  const res = await fetch(normalizeUrl(url) + p, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 401) throw new Error('Token ungültig (401)');
  if (res.status === 404) throw new Error('Nicht gefunden (404) – Entität oder URL prüfen');
  if (!res.ok) throw new Error(`Home Assistant antwortet mit ${res.status}`);
  return res.json();
}

/** WebSocket-Aufruf (Long-Term-Statistics gibt es nur per WebSocket-API). */
function haWs(url, token, commands, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(normalizeUrl(url).replace(/^http/, 'ws') + '/api/websocket');
    const results = [];
    const timer = setTimeout(() => { ws.close(); reject(new Error('WebSocket-Timeout')); }, timeoutMs);
    const done = (fn, v) => { clearTimeout(timer); try { ws.close(); } catch { /* ignore */ } fn(v); };
    ws.onerror = () => done(reject, new Error('WebSocket-Verbindung fehlgeschlagen'));
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.type === 'auth_required') return ws.send(JSON.stringify({ type: 'auth', access_token: token }));
      if (m.type === 'auth_invalid') return done(reject, new Error('Token ungültig'));
      if (m.type === 'auth_ok') return commands.forEach((c, i) => ws.send(JSON.stringify({ id: i + 1, ...c })));
      if (m.type === 'result') {
        results[m.id - 1] = m.success ? m.result : null;
        if (results.length >= commands.length && commands.every((_, i) => i in results)) done(resolve, results);
      }
    };
  });
}

const toMs = (v) => (typeof v === 'number' ? (v > 1e11 ? v : v * 1000) : Date.parse(v));

/** Mittelwert-Statistiken (5-Minuten für ~10 Tage, sonst Stundenwerte) als Stufen-Signal. */
async function fetchStats(s, entity, start, end) {
  const base = { type: 'recorder/statistics_during_period', start_time: new Date(start).toISOString(), end_time: new Date(end).toISOString(), statistic_ids: [entity], types: ['mean'] };
  const [short, hourly] = await haWs(s.haUrl, s.haToken, [{ ...base, period: '5minute' }, { ...base, period: 'hour' }]);
  const rows = (r) => (r?.[entity] || []).filter((x) => x.mean != null).map((x) => ({ a: toMs(x.start), b: toMs(x.end), v: x.mean }));
  const sh = rows(short), hr = rows(hourly);
  // Stundenwerte nur dort, wo keine 5-Minuten-Werte vorliegen
  const firstShort = sh.length ? sh[0].a : Infinity;
  const buckets = [...hr.filter((x) => x.b <= firstShort), ...sh];
  const pts = [];
  buckets.forEach((x, i) => {
    pts.push({ t: x.a, v: x.v });
    if (!buckets[i + 1] || buckets[i + 1].a > x.b) pts.push({ t: x.b, v: null });
  });
  return pts;
}

async function fetchHistory(s, entity, start, end) {
  const all = [];
  const CHUNK = 7 * DAY;
  for (let a = start; a < end; a += CHUNK) {
    const b = Math.min(a + CHUNK, end);
    const q = `/api/history/period/${encodeURIComponent(new Date(a).toISOString())}` +
      `?filter_entity_id=${encodeURIComponent(entity)}&end_time=${encodeURIComponent(new Date(b).toISOString())}` +
      `&minimal_response&no_attributes`;
    const data = await haFetch(s.haUrl, s.haToken, q, 60000);
    all.push(...parseHistory(data[0]));
  }
  const m = new Map();
  for (const p of all) m.set(p.t, p);
  return [...m.values()].sort((x, y) => x.t - y.t);
}

/** Bevorzugt Mittelwerte aus den Statistiken; Rest (laufender 5-Min-Block) und Fallback aus dem Verlauf. */
async function fetchEntity(s, entity, start, end) {
  let pts = [];
  try { pts = await fetchStats(s, entity, start, end); } catch { pts = []; }
  const hasStats = pts.length > 0;
  if (!hasStats) return { pts: await fetchHistory(s, entity, start, end), source: 'history' };
  const last = pts[pts.length - 1];
  const covered = last.v === null ? last.t : end;
  if (covered < end) {
    const tail = await fetchHistory(s, entity, covered, end).catch(() => []);
    const body = pts.filter((p) => !(p === last && last.v === null));
    const t2 = tail.filter((p) => p.t >= covered);
    if (t2.length) pts = [...body, ...t2];
  }
  return { pts, source: 'statistics' };
}

/* ---------- Berechnung ---------- */

async function calculate({ start, end, refKwh }) {
  const s = db.settings;
  if (!s.haUrl || !s.haToken || !s.entityPower) {
    throw new Error('Home Assistant ist noch nicht konfiguriert (Einstellungen).');
  }
  const now = Date.now();
  const startMs = start ? new Date(start).getTime() : NaN;
  if (Number.isNaN(startMs)) throw new Error('Startdatum fehlt oder ist ungültig.');
  let endMs = end ? new Date(end).getTime() : now;
  if (Number.isNaN(endMs)) throw new Error('Enddatum ungültig.');
  const open = !end || endMs > now;
  endMs = Math.min(endMs, now);
  if (endMs <= startMs) throw new Error('Das Ende muss nach dem Start liegen.');

  const none = { pts: [], source: null };
  const [pwR, voR, cuR] = await Promise.all([
    fetchEntity(s, s.entityPower, startMs, endMs),
    s.entityVoltage ? fetchEntity(s, s.entityVoltage, startMs, endMs) : none,
    s.entityCurrent ? fetchEntity(s, s.entityCurrent, startMs, endMs) : none,
  ]);
  const pw = pwR.pts, vo = voR.pts, cu = cuR.pts;

  const P = integrate(pw, startMs, endMs);
  const kwh = P.sum / 1000;
  const price = Number(s.pricePerKwh) || 0;
  const cost = kwh * price;
  const hours = (endMs - startMs) / 3600000;
  const coveredHours = P.coveredMs / 3600000; // Zeit mit tatsächlichen Messwerten

  const days = [];
  for (let d = dayStart(startMs); d < endMs; d = nextDay(d)) {
    const k = dayKey(d);
    const dk = (P.perDay[k] || 0) / 1000;
    days.push({ date: k, kwh: dk, cost: dk * price });
  }

  const avgOf = (pts) => {
    const r = integrate(pts, startMs, endMs);
    return r.coveredMs ? r.sum / (r.coveredMs / 3600000) : null;
  };
  const V = vo.length ? integrate(vo, startMs, endMs) : null;
  const C = cu.length ? integrate(cu, startMs, endMs) : null;

  const result = {
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
    open,
    hours,
    kwh,
    cost,
    pricePerKwh: price,
    coveredHours,
    avgWatt: coveredHours ? P.sum / coveredHours : 0,
    peakWatt: P.peak,
    avgVolt: avgOf(vo),
    avgAmpere: avgOf(cu),
    peakAmpere: C ? C.peak : null,
    coverage: hours ? Math.min(1, P.coveredMs / (endMs - startMs)) : 0,
    costPerDay: coveredHours ? cost / (coveredHours / 24) : 0,
    projectedYearKwh: coveredHours ? (kwh / coveredHours) * 8760 : 0,
    projectedYearCost: coveredHours ? (cost / coveredHours) * 8760 : 0,
    days,
    samples: pw.length,
    source: pwR.source,
  };
  if (refKwh > 0) {
    result.refKwh = refKwh;
    result.percent = (kwh / refKwh) * 100;
    result.refCost = refKwh * price;
  }
  return result;
}

/* ---------- HTTP ---------- */

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function json(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(s);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) { reject(new Error('Body zu groß')); req.destroy(); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('Ungültiges JSON')); } });
    req.on('error', reject);
  });
}
const num = (v, d = 0) => { const n = Number(String(v).replace(',', '.')); return Number.isFinite(n) ? n : d; };
const publicSettings = () => { const { haToken, ...rest } = db.settings; return { ...rest, hasToken: !!haToken }; };

async function api(req, res, url) {
  const p = url.pathname;
  const m = req.method;

  if (p === '/api/health') return json(res, 200, { ok: true });

  if (p === '/api/settings' && m === 'GET') return json(res, 200, publicSettings());
  if (p === '/api/settings' && m === 'PUT') {
    const b = await readBody(req);
    const s = db.settings;
    if (b.pricePerKwh !== undefined) s.pricePerKwh = Math.max(0, num(b.pricePerKwh, s.pricePerKwh));
    if (b.basePriceYear !== undefined) s.basePriceYear = Math.max(0, num(b.basePriceYear, 0));
    for (const k of ['haUrl', 'entityPower', 'entityVoltage', 'entityCurrent', 'measureStart', 'measureEnd']) {
      if (typeof b[k] === 'string') s[k] = k === 'haUrl' ? normalizeUrl(b[k]) : b[k].trim();
    }
    if (typeof b.haToken === 'string' && b.haToken.trim()) s.haToken = b.haToken.trim();
    if (b.clearToken) s.haToken = '';
    save();
    return json(res, 200, publicSettings());
  }

  if (p === '/api/history' && m === 'GET') {
    return json(res, 200, [...db.history].sort((a, b) => (b.to || '').localeCompare(a.to || '')));
  }
  if (p === '/api/history' && m === 'POST') {
    const b = await readBody(req);
    const kwh = num(b.kwh, NaN);
    if (!b.label || !Number.isFinite(kwh) || kwh <= 0) return json(res, 400, { error: 'Bezeichnung und kWh (> 0) sind nötig.' });
    const entry = {
      id: crypto.randomUUID(),
      label: String(b.label).trim().slice(0, 80),
      from: String(b.from || ''),
      to: String(b.to || ''),
      kwh,
      note: String(b.note || '').trim().slice(0, 200),
    };
    db.history.push(entry);
    save();
    return json(res, 201, entry);
  }
  const hm = p.match(/^\/api\/history\/([\w-]+)$/);
  if (hm && m === 'DELETE') {
    db.history = db.history.filter((e) => e.id !== hm[1]);
    save();
    return json(res, 200, { ok: true });
  }

  if (p === '/api/ha/test' && m === 'POST') {
    const s = db.settings;
    const b = await readBody(req);
    const url = typeof b.haUrl === 'string' && b.haUrl ? b.haUrl : s.haUrl;
    const token = typeof b.haToken === 'string' && b.haToken ? b.haToken : s.haToken;
    if (!url || !token) return json(res, 400, { error: 'URL und Token fehlen.' });
    try {
      await haFetch(url, token, '/api/', 8000);
      const out = {};
      for (const [k, id] of Object.entries({ power: b.entityPower ?? s.entityPower, voltage: b.entityVoltage ?? s.entityVoltage, current: b.entityCurrent ?? s.entityCurrent })) {
        if (!id) continue;
        try {
          const st = await haFetch(url, token, `/api/states/${encodeURIComponent(id)}`, 8000);
          out[k] = { ok: true, state: st.state, unit: st.attributes?.unit_of_measurement || '' };
        } catch (e) { out[k] = { ok: false, error: e.message }; }
      }
      return json(res, 200, { ok: true, entities: out });
    } catch (e) {
      return json(res, 200, { ok: false, error: e.cause?.code ? `${e.message} (${e.cause.code})` : e.message });
    }
  }

  if (p === '/api/calc' && m === 'GET') {
    try {
      const r = await calculate({
        start: url.searchParams.get('start'),
        end: url.searchParams.get('end'),
        refKwh: num(url.searchParams.get('refKwh'), 0),
      });
      return json(res, 200, r);
    } catch (e) {
      return json(res, 400, { error: e.cause?.code ? `${e.message} (${e.cause.code})` : e.message });
    }
  }
  return json(res, 404, { error: 'Not found' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    let f = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
    if (!f.startsWith(PUBLIC) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(PUBLIC, 'index.html');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});
server.listen(PORT, () => console.log(`Stromrechner läuft auf Port ${PORT} (TZ=${process.env.TZ || 'system'})`));
