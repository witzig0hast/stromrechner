'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DAY, nextDay, dayStart, dayKey, integrate, parseHistory, normalizeUrl } = require('./lib');

const PORT = Number(process.env.PORT) || 3000;
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

async function fetchEntity(s, entity, start, end) {
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
  // dedupe by timestamp, keep last
  const m = new Map();
  for (const p of all) m.set(p.t, p);
  return [...m.values()].sort((x, y) => x.t - y.t);
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

  const [pw, vo, cu] = await Promise.all([
    fetchEntity(s, s.entityPower, startMs, endMs),
    s.entityVoltage ? fetchEntity(s, s.entityVoltage, startMs, endMs) : [],
    s.entityCurrent ? fetchEntity(s, s.entityCurrent, startMs, endMs) : [],
  ]);

  const P = integrate(pw, startMs, endMs);
  const kwh = P.sum / 1000;
  const price = Number(s.pricePerKwh) || 0;
  const cost = kwh * price;
  const hours = (endMs - startMs) / 3600000;

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
    avgWatt: hours ? P.sum / hours : 0,
    peakWatt: P.peak,
    avgVolt: avgOf(vo),
    avgAmpere: avgOf(cu),
    peakAmpere: C ? C.peak : null,
    coverage: hours ? Math.min(1, P.coveredMs / (endMs - startMs)) : 0,
    costPerDay: days.length ? cost / (hours / 24) : 0,
    projectedYearKwh: hours ? (kwh / hours) * 8760 : 0,
    projectedYearCost: hours ? (cost / hours) * 8760 : 0,
    days,
    samples: pw.length,
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
