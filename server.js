'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const auth = require('./auth');
const { sendMail, parseAddrs, EMAIL_RE } = require('./smtp');
const { runChecks, buildAlertMail, buildTestMail, neededStart } = require('./alerts');
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
    smtpHost: '',
    smtpPort: 465,           // direktes TLS (SMTPS), kein STARTTLS
    smtpUser: '',
    smtpPass: '',
    smtpFrom: '',
    smtpTo: '',
    smtpVerify: true,
    alertsEnabled: false,
    alertTime: '08:00',
    alertDayPct: 30,
    alertMonthPct: 25,
    alertMinKwh: 0.2,
  },
  history: [],
  alerts: [],
  alertState: {},
};

fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
let db = structuredClone(DEFAULTS);
try {
  const saved = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  db = { settings: { ...DEFAULTS.settings, ...saved.settings }, history: saved.history || [], alerts: saved.alerts || [], alertState: saved.alertState || {}, auth: saved.auth || null, sessions: saved.sessions || {} };
} catch { /* first start */ }

auth.loadSessions(db.sessions, () => saveSoon());
let saveTimer = null;
const saveSoon = () => { clearTimeout(saveTimer); saveTimer = setTimeout(save, 1000); };
function save() {
  const tmp = DB_FILE + '.tmp';
  db.sessions = auth.dumpSessions();
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), { mode: 0o600 });
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

/* ---------- Benachrichtigungen ---------- */

function mergeSmtp(b = {}) {
  const s = { ...db.settings };
  const host = typeof b.smtpHost === 'string' && b.smtpHost ? str(b.smtpHost, 253).toLowerCase() : s.smtpHost;
  if (host && !HOST_RE.test(host)) return { error: 'SMTP-Server ist ungültig.' };
  const newPass = typeof b.smtpPass === 'string' && b.smtpPass ? b.smtpPass.slice(0, 500) : '';
  // gespeichertes Passwort nur an den gespeicherten Server senden
  if (!newPass && host !== s.smtpHost) return { error: 'Bei geändertem Server bitte das Passwort neu eingeben.' };
  s.smtpHost = host;
  if (newPass) s.smtpPass = newPass;
  for (const k of ['smtpUser', 'smtpFrom', 'smtpTo']) if (typeof b[k] === 'string' && b[k]) s[k] = str(b[k], 500);
  if (b.smtpPort) { const n = Math.round(Number(b.smtpPort)); s.smtpPort = n > 0 && n < 65536 ? n : 465; }
  if (typeof b.smtpVerify === 'boolean') s.smtpVerify = b.smtpVerify;
  return s;
}
const smtpConfig = (s) => ({
  host: s.smtpHost, port: s.smtpPort || 465, user: s.smtpUser, pass: s.smtpPass, verify: s.smtpVerify !== false,
  from: s.smtpFrom, fromName: 'Stromrechner', to: parseAddrs(s.smtpTo),
});
const deliver = (cfg, mail) => sendMail({ ...cfg, ...mail });

let checking = false;
/** Prüft Verbrauch gegen Vortage/Vormonate; sendet bei Auffälligkeit eine Mail. */
async function runAlertCheck({ send, force = false }) {
  if (checking) throw new Error('Prüfung läuft bereits.');
  checking = true;
  try {
    const s = db.settings;
    if (!s.haUrl || !s.haToken || !s.entityPower) throw new Error('Home Assistant ist noch nicht konfiguriert.');
    const now = Date.now();
    const { pts } = await fetchEntity(s, s.entityPower, neededStart(now), now);
    const { checks, findings } = runChecks(pts, s, now);

    // Doppelte Warnungen vermeiden: Tag je Datum einmal, Monat max. alle 7 Tage
    const st = db.alertState;
    const fresh = force ? findings : findings.filter((f) =>
      f.kind === 'day' ? st.lastDayId !== f.id : !st.lastMonthAt || now - st.lastMonthAt > 7 * DAY);
    let sent = false, error = null;
    if (send && fresh.length) {
      try {
        await deliver(smtpConfig(s), buildAlertMail(fresh, s));
        sent = true;
        for (const f of fresh) {
          if (f.kind === 'day') st.lastDayId = f.id; else st.lastMonthAt = now;
          db.alerts.unshift({ at: new Date(now).toISOString(), kind: f.kind, label: f.label, deltaPct: Number.isFinite(f.deltaPct) ? f.deltaPct : null, current: f.current, reference: f.reference, causes: f.causes });
        }
        db.alerts = db.alerts.slice(0, 50);
      } catch (e) { error = e.message; }
    }
    save();
    return { checks, findings, sent, error, pending: fresh.length };
  } finally { checking = false; }
}

/** Täglicher Zeitplan (lokale Zeit, Prüfung pro Minute). */
async function scheduler() {
  const s = db.settings, st = db.alertState;
  if (!s.alertsEnabled || !s.smtpHost) return;
  const d = new Date(), today = dayKey(d.getTime());
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (st.lastRunDay === today || hhmm < s.alertTime || (st.retryAt && Date.now() < st.retryAt)) return;
  try {
    const r = await runAlertCheck({ send: true });
    if (r.error) throw new Error(r.error);
    st.lastRunDay = today; st.retryAt = 0; st.lastError = null; st.attempts = 0;
  } catch (e) {
    st.attempts = (st.attempts || 0) + 1;
    st.lastError = `${new Date().toLocaleString('de-DE')}: ${e.message}`;
    if (st.attempts >= 3) { st.lastRunDay = today; st.attempts = 0; st.retryAt = 0; } else st.retryAt = Date.now() + 30 * 60000;
    console.error('Alarm-Prüfung fehlgeschlagen:', e.message);
  }
  save();
}
setInterval(() => scheduler().catch((e) => console.error(e)), 60000);

/* ---------- HTTP ---------- */

/**
 * Reverse-Proxy-Erkennung (TRUST_PROXY): "auto" (Standard) vertraut X-Forwarded-* nur, wenn die direkte
 * Verbindung von einer lokalen/privaten Adresse kommt (typisch: Proxy im Docker-/Heimnetz).
 * "1" vertraut immer, "0" nie.
 */
const TRUST_MODE = (process.env.TRUST_PROXY || 'auto').toLowerCase();
const PRIVATE_RE = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1$|f[cd][0-9a-f]{2}:|fe80:|::ffff:(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.))/i;
const peerIp = (req) => req.socket.remoteAddress || 'unknown';
const trusted = (req) => TRUST_MODE === '1' || TRUST_MODE === 'true' || (TRUST_MODE === 'auto' && PRIVATE_RE.test(peerIp(req)));
const fwd = (req, name) => String(req.headers[name] || '').split(',').map((x) => x.trim()).filter(Boolean);
const COOKIE = 'sr_session';
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
};
const STATIC_CACHE = Object.fromEntries(Object.entries(STATIC).map(([k, [f]]) => [k, fs.readFileSync(path.join(PUBLIC, f))]));

const SEC_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
};
const isHttps = (req) => !!req.socket.encrypted || (trusted(req) && fwd(req, 'x-forwarded-proto')[0] === 'https');
const clientIp = (req) => (trusted(req) ? fwd(req, 'x-forwarded-for').pop() : null) || peerIp(req);
/* Sperre zählt pro Client-IP (5 Versuche) und zusätzlich pro Proxy-Verbindung (30), damit gefälschte Header nicht helfen */
const lockWait = (req) => Math.max(auth.lockedFor(clientIp(req)), auth.lockedFor('peer:' + peerIp(req)));
const lockFail = (req) => { auth.recordFail(clientIp(req)); auth.recordFail('peer:' + peerIp(req), 30); };
const lockClear = (req) => auth.clearFails(clientIp(req));

function send(req, res, code, body, headers = {}) {
  const h = { ...SEC_HEADERS, ...headers };
  if (isHttps(req)) h['Strict-Transport-Security'] = 'max-age=31536000';
  res.writeHead(code, h);
  res.end(body);
}
function json(req, res, code, body, headers = {}) {
  send(req, res, code, JSON.stringify(body), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
}
class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }

function readBody(req) {
  return new Promise((resolve, reject) => {
    if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return reject(new HttpError(415, 'Content-Type muss application/json sein'));
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { data += c; if (data.length > 65536) { reject(new HttpError(413, 'Anfrage zu groß')); req.destroy(); } });
    req.on('end', () => { try { const j = data ? JSON.parse(data) : {}; resolve(j && typeof j === 'object' && !Array.isArray(j) ? j : {}); } catch { reject(new HttpError(400, 'Ungültiges JSON')); } });
    req.on('error', reject);
  });
}
const num = (v, d = 0) => { const n = Number(String(v).replace(',', '.')); return Number.isFinite(n) ? n : d; };
const str = (v, max = 200) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '');
const publicSettings = () => { const { haToken, smtpPass, ...rest } = db.settings; return { ...rest, hasToken: !!haToken, hasSmtpPass: !!smtpPass }; };

const ENTITY_RE = /^[a-z0-9_]+\.[a-z0-9_]+$/;
const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]*[a-z0-9])?$|^\[[0-9a-f:]+\]$/i;
const LOCAL_DT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const MAX_RANGE_DAYS = 800;

/** HA-URL prüfen: nur http(s), keine Zugangsdaten/Query. Gibt normalisierte URL oder wirft. */
function cleanHaUrl(v) {
  const t = String(v || '').trim();
  if (!t) return '';
  let u;
  try { u = new URL(t); } catch { throw new HttpError(400, 'Home-Assistant-URL ist ungültig.'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new HttpError(400, 'Nur http:// oder https:// erlaubt.');
  if (u.username || u.password || u.search || u.hash) throw new HttpError(400, 'URL darf keine Zugangsdaten, Parameter oder Anker enthalten.');
  return (u.origin + u.pathname).replace(/\/+$/, '');
}
function cleanEntity(v) {
  const t = str(v, 120).toLowerCase();
  if (t && !ENTITY_RE.test(t)) throw new HttpError(400, `Ungültige Entität: ${t.slice(0, 60)}`);
  return t;
}

/* Sitzungs-/Auth-Zustand */
const ENV_PASSWORD = process.env.ADMIN_PASSWORD || '';
let authRecord = db.auth || null;
let setupCode = null;
(async () => {
  if (ENV_PASSWORD) {
    if (ENV_PASSWORD.length < auth.MIN_PW) { console.error(`ADMIN_PASSWORD ist zu kurz (mind. ${auth.MIN_PW} Zeichen).`); process.exit(1); }
    authRecord = await auth.hashPassword(ENV_PASSWORD);
  } else if (!authRecord) {
    setupCode = crypto.randomBytes(5).toString('hex');
    console.log(`\n=== EINRICHTUNG ===\nNoch kein Passwort gesetzt. Einrichtungscode (nur in diesem Log sichtbar): ${setupCode}\nÖffne die Web-Oberfläche und lege dort das Passwort fest.\n===================\n`);
  }
})();

function sessionOf(req) {
  const tok = auth.parseCookies(req.headers.cookie)[COOKIE];
  const sess = auth.getSession(tok);
  return { tok, sess };
}
function sessionCookie(req, token, maxAge) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`;
}
/** Origin-Prüfung gegen CSRF bei schreibenden Anfragen. */
function sameOrigin(req) {
  const o = req.headers.origin;
  if (!o) return true; // gleiche Herkunft ohne Origin-Header (SameSite=Strict schützt zusätzlich)
  let host;
  try { host = new URL(o).host; } catch { return false; }
  const allowed = [req.headers.host];
  if (trusted(req)) allowed.push(fwd(req, 'x-forwarded-host')[0]);
  return allowed.includes(host);
}

async function authApi(req, res, p, m, ip) {
  if (p === '/api/auth/state' && m === 'GET') {
    const { sess } = sessionOf(req);
    return json(req, res, 200, { setupRequired: !authRecord, authenticated: !!sess, csrf: sess ? sess.csrf : null, managedByEnv: !!ENV_PASSWORD });
  }
  if (p === '/api/auth/setup' && m === 'POST') {
    if (authRecord) throw new HttpError(409, 'Passwort ist bereits gesetzt.');
    const wait = lockWait(req);
    if (wait) throw new HttpError(429, `Zu viele Versuche. Bitte ${wait} s warten.`);
    const b = await readBody(req);
    if (!setupCode || !auth.safeEq(str(b.code, 40), setupCode)) { lockFail(req); throw new HttpError(403, 'Einrichtungscode falsch (siehe Container-Log).'); }
    const pw = typeof b.password === 'string' ? b.password : '';
    if (pw.length < auth.MIN_PW || pw.length > 200) throw new HttpError(400, `Passwort muss mindestens ${auth.MIN_PW} Zeichen lang sein.`);
    authRecord = await auth.hashPassword(pw);
    db.auth = authRecord; setupCode = null; save();
    lockClear(req);
    const { token, sess } = auth.createSession();
    return json(req, res, 200, { ok: true, csrf: sess.csrf }, { 'Set-Cookie': sessionCookie(req, token, 7 * 86400) });
  }
  if (p === '/api/auth/login' && m === 'POST') {
    const wait = lockWait(req);
    if (wait) throw new HttpError(429, `Zu viele Fehlversuche. Bitte ${Math.ceil(wait / 60)} Min. warten.`);
    const b = await readBody(req);
    const ok = authRecord && await auth.verifyPassword(typeof b.password === 'string' ? b.password.slice(0, 200) : '', authRecord);
    if (!ok) { lockFail(req); throw new HttpError(401, 'Passwort falsch.'); }
    lockClear(req);
    const { token, sess } = auth.createSession();
    return json(req, res, 200, { ok: true, csrf: sess.csrf }, { 'Set-Cookie': sessionCookie(req, token, 7 * 86400) });
  }
  if (p === '/api/auth/logout' && m === 'POST') {
    const { tok, sess } = sessionOf(req);
    if (sess && req.headers['x-csrf-token'] === sess.csrf) auth.destroySession(tok);
    return json(req, res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) });
  }
  return null;
}

let calcCache = new Map(), calcRunning = 0;

async function api(req, res, url, ip) {
  const p = url.pathname, m = req.method;

  if (p === '/api/health') return json(req, res, 200, { ok: true });
  if (m !== 'GET' && m !== 'HEAD' && !sameOrigin(req)) throw new HttpError(403, 'Ungültige Herkunft');

  if (p.startsWith('/api/auth/')) {
    const r = await authApi(req, res, p, m, ip);
    if (r !== null) return r;
    throw new HttpError(404, 'Nicht gefunden');
  }

  // ab hier nur mit gültiger Sitzung
  const { tok, sess } = sessionOf(req);
  if (!sess) throw new HttpError(401, 'Nicht angemeldet');
  if (m !== 'GET' && m !== 'HEAD' && !auth.safeEq(req.headers['x-csrf-token'] || '', sess.csrf)) throw new HttpError(403, 'CSRF-Token ungültig');

  if (p === '/api/settings' && m === 'GET') return json(req, res, 200, publicSettings());
  if (p === '/api/settings' && m === 'PUT') {
    const b = await readBody(req);
    const s = db.settings;
    if (b.pricePerKwh !== undefined) s.pricePerKwh = Math.min(100, Math.max(0, num(b.pricePerKwh, s.pricePerKwh)));
    if (b.basePriceYear !== undefined) s.basePriceYear = Math.min(100000, Math.max(0, num(b.basePriceYear, 0)));
    for (const k of ['measureStart', 'measureEnd']) {
      if (typeof b[k] === 'string') { if (b[k] && !LOCAL_DT.test(b[k])) throw new HttpError(400, 'Ungültiges Datum.'); s[k] = b[k]; }
    }
    // Home Assistant: bei geänderter URL muss der Token neu eingegeben werden (kein Token-Leak an fremde Hosts)
    if (typeof b.haUrl === 'string') {
      const nu = cleanHaUrl(b.haUrl);
      if (nu !== s.haUrl) { s.haUrl = nu; if (!(typeof b.haToken === 'string' && b.haToken.trim())) s.haToken = ''; }
    }
    for (const k of ['entityPower', 'entityVoltage', 'entityCurrent']) if (typeof b[k] === 'string') s[k] = cleanEntity(b[k]);
    if (typeof b.haToken === 'string' && b.haToken.trim()) s.haToken = b.haToken.trim().slice(0, 4096);
    if (b.clearToken === true) s.haToken = '';
    // SMTP: bei geändertem Server muss das Passwort neu eingegeben werden
    if (typeof b.smtpHost === 'string') {
      const h = str(b.smtpHost, 253).toLowerCase();
      if (h && !HOST_RE.test(h)) throw new HttpError(400, 'SMTP-Server ist ungültig.');
      if (h !== s.smtpHost) { s.smtpHost = h; if (!(typeof b.smtpPass === 'string' && b.smtpPass)) s.smtpPass = ''; }
    }
    for (const k of ['smtpUser']) if (typeof b[k] === 'string') s[k] = str(b[k], 200);
    for (const k of ['smtpFrom', 'smtpTo']) if (typeof b[k] === 'string') {
      const v = str(b[k], 500);
      if (v && !v.split(/[,;\s]+/).filter(Boolean).every((x) => EMAIL_RE.test(x))) throw new HttpError(400, 'E-Mail-Adresse ungültig.');
      s[k] = v;
    }
    if (typeof b.smtpPass === 'string' && b.smtpPass) s.smtpPass = b.smtpPass.slice(0, 500);
    if (b.clearSmtpPass === true) s.smtpPass = '';
    if (b.smtpPort !== undefined) { const n = Math.round(num(b.smtpPort, 465)); s.smtpPort = n > 0 && n < 65536 ? n : 465; }
    for (const k of ['smtpVerify', 'alertsEnabled']) if (typeof b[k] === 'boolean') s[k] = b[k];
    if (typeof b.alertTime === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(b.alertTime)) s.alertTime = b.alertTime;
    if (b.alertDayPct !== undefined) s.alertDayPct = Math.min(10000, Math.max(1, num(b.alertDayPct, s.alertDayPct)));
    if (b.alertMonthPct !== undefined) s.alertMonthPct = Math.min(10000, Math.max(1, num(b.alertMonthPct, s.alertMonthPct)));
    if (b.alertMinKwh !== undefined) s.alertMinKwh = Math.min(1000, Math.max(0, num(b.alertMinKwh, s.alertMinKwh)));
    save();
    calcCache.clear();
    return json(req, res, 200, publicSettings());
  }

  if (p === '/api/history' && m === 'GET') {
    return json(req, res, 200, [...db.history].sort((a, b) => (b.to || '').localeCompare(a.to || '')));
  }
  if (p === '/api/history' && m === 'POST') {
    const b = await readBody(req);
    const kwh = num(b.kwh, NaN);
    const label = str(b.label, 80);
    if (!label || !Number.isFinite(kwh) || kwh <= 0 || kwh > 1e7) return json(req, res, 400, { error: 'Bezeichnung und kWh (> 0) sind nötig.' });
    const d = (v) => { const t = str(v, 10); if (t && !/^\d{4}-\d{2}-\d{2}$/.test(t)) throw new HttpError(400, 'Ungültiges Datum.'); return t; };
    if (db.history.length >= 500) throw new HttpError(400, 'Maximal 500 Einträge.');
    const entry = { id: crypto.randomUUID(), label, from: d(b.from), to: d(b.to), kwh, note: str(b.note, 200) };
    db.history.push(entry);
    save();
    return json(req, res, 201, entry);
  }
  const hm = p.match(/^\/api\/history\/([\w-]{1,64})$/);
  if (hm && m === 'DELETE') {
    db.history = db.history.filter((e) => e.id !== hm[1]);
    save();
    return json(req, res, 200, { ok: true });
  }

  if (p === '/api/ha/test' && m === 'POST') {
    const s = db.settings;
    const b = await readBody(req);
    const url = typeof b.haUrl === 'string' && b.haUrl ? cleanHaUrl(b.haUrl) : s.haUrl;
    const newTok = typeof b.haToken === 'string' && b.haToken.trim() ? b.haToken.trim() : '';
    // gespeicherter Token wird nur an die gespeicherte URL gesendet
    if (!newTok && url !== s.haUrl) return json(req, res, 400, { error: 'Bei geänderter URL bitte den Token neu eingeben.' });
    const token = newTok || s.haToken;
    if (!url || !token) return json(req, res, 400, { error: 'URL und Token fehlen.' });
    try {
      await haFetch(url, token, '/api/', 8000);
      const out = {};
      for (const [k, raw] of Object.entries({ power: b.entityPower ?? s.entityPower, voltage: b.entityVoltage ?? s.entityVoltage, current: b.entityCurrent ?? s.entityCurrent })) {
        const id = cleanEntity(raw);
        if (!id) continue;
        try {
          const st = await haFetch(url, token, `/api/states/${encodeURIComponent(id)}`, 8000);
          out[k] = { ok: true, state: String(st.state).slice(0, 40), unit: String(st.attributes?.unit_of_measurement || '').slice(0, 10) };
        } catch (e) { out[k] = { ok: false, error: e.message }; }
      }
      return json(req, res, 200, { ok: true, entities: out });
    } catch (e) {
      return json(req, res, 200, { ok: false, error: e.cause?.code ? `${e.message} (${e.cause.code})` : e.message });
    }
  }

  if (p === '/api/mail/test' && m === 'POST') {
    const b = await readBody(req);
    try {
      const cfg = mergeSmtp(b);
      if (cfg.error) return json(req, res, 200, { ok: false, error: cfg.error });
      await deliver(smtpConfig(cfg), buildTestMail());
      return json(req, res, 200, { ok: true });
    } catch (e) { return json(req, res, 200, { ok: false, error: e.message }); }
  }

  if (p === '/api/alerts' && m === 'GET') return json(req, res, 200, { log: db.alerts, state: { lastError: db.alertState.lastError || null } });
  if (p === '/api/alerts/check' && m === 'POST') {
    const b = await readBody(req);
    try { return json(req, res, 200, await runAlertCheck({ send: b.send === true, force: true })); }
    catch (e) { return json(req, res, 400, { error: e.message }); }
  }

  if (p === '/api/calc' && m === 'GET') {
    const start = url.searchParams.get('start') || '', end = url.searchParams.get('end') || '';
    if (!LOCAL_DT.test(start) || (end && !LOCAL_DT.test(end))) throw new HttpError(400, 'Ungültiges Datumsformat.');
    const refKwh = Math.min(1e7, Math.max(0, num(url.searchParams.get('refKwh'), 0)));
    if ((end ? new Date(end) : new Date()) - new Date(start) > MAX_RANGE_DAYS * 86400e3) throw new HttpError(400, `Zeitraum darf höchstens ${MAX_RANGE_DAYS} Tage umfassen.`);
    const key = `${start}|${end}|${refKwh}`;
    const hit = calcCache.get(key);
    if (hit && Date.now() - hit.t < 20000) return json(req, res, 200, hit.v);
    if (calcRunning >= 2) throw new HttpError(429, 'Es laufen bereits Berechnungen – bitte kurz warten.');
    calcRunning++;
    try {
      const r = await calculate({ start, end, refKwh });
      if (calcCache.size > 50) calcCache.clear();
      calcCache.set(key, { t: Date.now(), v: r });
      return json(req, res, 200, r);
    } catch (e) {
      return json(req, res, 400, { error: e.cause?.code ? `${e.message} (${e.cause.code})` : e.message });
    } finally { calcRunning--; }
  }
  throw new HttpError(404, 'Nicht gefunden');
}

const server = http.createServer(async (req, res) => {
  const ip = clientIp(req);
  try {
    if (!['GET', 'HEAD', 'POST', 'PUT', 'DELETE'].includes(req.method)) throw new HttpError(405, 'Methode nicht erlaubt');
    if (!auth.rateLimit(ip)) throw new HttpError(429, 'Zu viele Anfragen');
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/api/')) {
      if (url.pathname === '/api/auth/password' && req.method === 'POST') return await changePassword(req, res);
      return await api(req, res, url, ip);
    }
    const hit = STATIC[url.pathname];
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Methode nicht erlaubt');
    const file = hit ? STATIC_CACHE[url.pathname] : STATIC_CACHE['/']; // SPA-Fallback
    const type = hit ? hit[1] : STATIC['/'][1];
    return send(req, res, 200, req.method === 'HEAD' ? '' : file, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
  } catch (e) {
    if (e instanceof HttpError) return json(req, res, e.code, { error: e.message });
    console.error('Fehler:', e.message);
    return json(req, res, 500, { error: 'Interner Fehler' });
  }
});

async function changePassword(req, res) {
  const { tok, sess } = sessionOf(req);
  if (!sess) throw new HttpError(401, 'Nicht angemeldet');
  if (!sameOrigin(req) || !auth.safeEq(req.headers['x-csrf-token'] || '', sess.csrf)) throw new HttpError(403, 'CSRF-Token ungültig');
  if (ENV_PASSWORD) throw new HttpError(400, 'Das Passwort wird über ADMIN_PASSWORD verwaltet.');
  const ip = clientIp(req);
  const wait = lockWait(req);
  if (wait) throw new HttpError(429, `Zu viele Fehlversuche. Bitte ${Math.ceil(wait / 60)} Min. warten.`);
  const b = await readBody(req);
  if (!(await auth.verifyPassword(typeof b.current === 'string' ? b.current.slice(0, 200) : '', authRecord))) { lockFail(req); throw new HttpError(403, 'Aktuelles Passwort falsch.'); }
  const pw = typeof b.password === 'string' ? b.password : '';
  if (pw.length < auth.MIN_PW || pw.length > 200) throw new HttpError(400, `Neues Passwort muss mindestens ${auth.MIN_PW} Zeichen lang sein.`);
  authRecord = await auth.hashPassword(pw);
  db.auth = authRecord; save();
  auth.destroyAllExcept(tok);
  return json(req, res, 200, { ok: true });
}

server.headersTimeout = 15000;
server.requestTimeout = 30000;
server.keepAliveTimeout = 5000;
server.maxRequestsPerSocket = 200;
process.on('unhandledRejection', (e) => console.error('Unhandled:', e && e.message));
server.listen(PORT, () => console.log(`Stromrechner läuft auf Port ${PORT} (TZ=${process.env.TZ || 'system'})`));
