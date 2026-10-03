'use strict';
const tls = require('node:tls');
const os = require('node:os');
const crypto = require('node:crypto');

const EMAIL_RE = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;
const clean = (s) => String(s || '').replace(/[\r\n]+/g, ' ').trim();
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const wrap = (s) => s.replace(/(.{76})/g, '$1\r\n');
const encWord = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);

function parseAddrs(list) {
  return String(list || '').split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
}

function buildMessage({ from, fromName, to, subject, text, html }) {
  const boundary = 'sr_' + crypto.randomBytes(12).toString('hex');
  const domain = (from.split('@')[1] || 'localhost');
  const head = [
    `From: ${fromName ? `${encWord(clean(fromName))} <${from}>` : from}`,
    `To: ${to.join(', ')}`,
    `Subject: ${encWord(clean(subject))}`,
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  const part = (type, body) => `--${boundary}\r\nContent-Type: ${type}; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap(b64(body))}\r\n`;
  return head.join('\r\n') + '\r\n\r\n' + part('text/plain', text) + part('text/html', html) + `--${boundary}--\r\n`;
}

/**
 * Sendet eine Mail über SMTP mit implizitem TLS (SMTPS, typisch Port 465) – kein STARTTLS.
 * cfg: { host, port, user, pass, verify, from, fromName, to:[], subject, text, html }
 */
function sendMail(cfg, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    if (!cfg.host) return reject(new Error('SMTP-Server fehlt.'));
    if (!EMAIL_RE.test(cfg.from)) return reject(new Error('Absender-Adresse ungültig.'));
    if (!cfg.to.length || !cfg.to.every((a) => EMAIL_RE.test(a))) return reject(new Error('Empfänger-Adresse(n) ungültig.'));

    const sock = tls.connect({ host: cfg.host, port: cfg.port || 465, servername: cfg.host, rejectUnauthorized: cfg.verify !== false });
    sock.setEncoding('utf8');
    let buf = '', waiter = null, finished = false;
    const fail = (e) => { if (finished) return; finished = true; clearTimeout(timer); sock.destroy(); reject(e instanceof Error ? e : new Error(String(e))); };
    const timer = setTimeout(() => fail(new Error('SMTP-Timeout')), timeoutMs);
    sock.on('error', (e) => fail(new Error(`SMTP-Verbindung fehlgeschlagen: ${e.code || e.message}`)));
    sock.on('close', () => fail(new Error('SMTP-Verbindung unerwartet beendet')));

    // vollständige (ggf. mehrzeilige) Antwort lesen
    sock.on('data', (d) => {
      buf += d;
      const lines = buf.split('\r\n');
      if (lines.length < 2) return;
      const complete = lines.slice(0, -1);
      const last = complete[complete.length - 1];
      if (/^\d{3} /.test(last) || /^\d{3}$/.test(last)) {
        buf = lines[lines.length - 1];
        if (waiter) { const w = waiter; waiter = null; w({ code: Number(last.slice(0, 3)), text: complete.join('\n') }); }
      }
    });
    const reply = () => new Promise((res) => { waiter = res; });
    const cmd = async (line, ok) => {
      if (line !== null) sock.write(line + '\r\n');
      const r = await reply();
      if (!ok.includes(r.code)) throw new Error(`SMTP ${r.code}: ${r.text.split('\n').pop().slice(4)}`);
      return r;
    };

    sock.once('secureConnect', async () => {
      try {
        await cmd(null, [220]);
        const ehlo = await cmd(`EHLO ${os.hostname().replace(/[^\w.-]/g, '') || 'stromrechner'}`, [250]);
        if (cfg.user) {
          const mechs = (ehlo.text.match(/AUTH[ =]([^\n]*)/i) || [, 'PLAIN LOGIN'])[1].toUpperCase();
          if (mechs.includes('PLAIN')) {
            await cmd('AUTH PLAIN ' + b64(`\0${cfg.user}\0${cfg.pass || ''}`), [235]);
          } else {
            await cmd('AUTH LOGIN', [334]);
            await cmd(b64(cfg.user), [334]);
            await cmd(b64(cfg.pass || ''), [235]);
          }
        }
        await cmd(`MAIL FROM:<${cfg.from}>`, [250]);
        for (const r of cfg.to) await cmd(`RCPT TO:<${r}>`, [250, 251]);
        await cmd('DATA', [354]);
        const msg = buildMessage(cfg).replace(/^\./gm, '..');
        await cmd(msg + '\r\n.', [250]);
        sock.write('QUIT\r\n');
        finished = true; clearTimeout(timer); sock.end();
        resolve({ ok: true });
      } catch (e) { fail(e); }
    });
  });
}

module.exports = { sendMail, parseAddrs, EMAIL_RE };
