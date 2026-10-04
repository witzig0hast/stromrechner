'use strict';
const crypto = require('node:crypto');

const IDLE_MS = 12 * 3600e3;      // Inaktivität
const ABSOLUTE_MS = 7 * 86400e3;  // maximale Sitzungsdauer
const MIN_PW = 10;

/* ---------- Passwort-Hashing (scrypt) ---------- */
const scrypt = (pw, salt) => new Promise((res, rej) =>
  crypto.scrypt(pw, salt, 64, { N: 2 ** 15, r: 8, p: 1, maxmem: 96 * 1024 * 1024 }, (e, k) => (e ? rej(e) : res(k))));

async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return { salt: salt.toString('base64'), hash: (await scrypt(pw, salt)).toString('base64') };
}
async function verifyPassword(pw, rec) {
  if (!rec || typeof pw !== 'string') { await scrypt('x', Buffer.alloc(16)); return false; } // gleiche Laufzeit
  const k = await scrypt(pw, Buffer.from(rec.salt, 'base64'));
  const h = Buffer.from(rec.hash, 'base64');
  return h.length === k.length && crypto.timingSafeEqual(h, k);
}
const safeEq = (a, b) => {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
};

/* ---------- Sitzungen (nur Hash des Cookies im Speicher) ---------- */
const sessions = new Map();
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');

function createSession() {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  const sess = { created: now, last: now, csrf: crypto.randomBytes(24).toString('base64url') };
  sessions.set(sha(token), sess);
  return { token, sess };
}
function getSession(token) {
  if (!token) return null;
  const k = sha(token), s = sessions.get(k), now = Date.now();
  if (!s) return null;
  if (now - s.last > IDLE_MS || now - s.created > ABSOLUTE_MS) { sessions.delete(k); return null; }
  s.last = now;
  return s;
}
const destroySession = (token) => { if (token) sessions.delete(sha(token)); };
function destroyAllExcept(keepToken) {
  const keep = keepToken ? sha(keepToken) : null;
  for (const k of sessions.keys()) if (k !== keep) sessions.delete(k);
}
setInterval(() => { const now = Date.now(); for (const [k, s] of sessions) if (now - s.last > IDLE_MS || now - s.created > ABSOLUTE_MS) sessions.delete(k); }, 600e3).unref();

/* ---------- Rate-Limits ---------- */
const fails = new Map();   // ip -> {n, until}
const hits = new Map();    // ip -> {n, reset}

function lockedFor(ip) {
  const f = fails.get(ip);
  return f && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 1000) : 0;
}
function recordFail(ip) {
  const f = fails.get(ip) || { n: 0, until: 0 };
  f.n += 1;
  if (f.n >= 5) { f.until = Date.now() + 15 * 60e3; f.n = 0; }
  fails.set(ip, f);
}
const clearFails = (ip) => fails.delete(ip);

/** Allgemeines Limit: max. `limit` Anfragen pro Minute und IP. */
function rateLimit(ip, limit = 300) {
  const now = Date.now();
  let h = hits.get(ip);
  if (!h || h.reset < now) { h = { n: 0, reset: now + 60e3 }; hits.set(ip, h); }
  h.n += 1;
  return h.n <= limit;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, h] of hits) if (h.reset < now) hits.delete(k);
  for (const [k, f] of fails) if (f.until < now && f.n === 0) fails.delete(k);
}, 300e3).unref();

const parseCookies = (h) => Object.fromEntries(String(h || '').split(';').map((c) => { const i = c.indexOf('='); return i < 0 ? ['', ''] : [c.slice(0, i).trim(), c.slice(i + 1).trim()]; }));

module.exports = { MIN_PW, hashPassword, verifyPassword, safeEq, createSession, getSession, destroySession, destroyAllExcept, lockedFor, recordFail, clearFails, rateLimit, parseCookies };
