// GET /api/nowplaying?url=<stream radio>  →  { "title": "Artist - Piesă" } sau { "title": null }
// Citește doar metadatele ICY (titlul piesei) din stream: maxim ~70 KB, maxim 6 secunde.
const net = require('net');
const tls = require('tls');
const dns = require('dns').promises;

const MAX_BYTES = 70 * 1024;
const TIMEOUT_MS = 6000;

// Blocăm adrese interne (funcția nu trebuie să poată fi folosită ca proxy spre rețele private)
function isPrivate(ip) {
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    return v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('::ffff:127.') || v === '::';
  }
  const p = ip.split('.').map(Number);
  return p[0] === 10 || p[0] === 127 || p[0] === 0 || (p[0] === 169 && p[1] === 254) ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) ||
    (p[0] === 100 && p[1] >= 64 && p[1] <= 127) || p[0] >= 224;
}

function readIcy(target, redirects = 0) {
  return new Promise(async (resolve) => {
    let u;
    try { u = new URL(target); } catch { return resolve(null); }
    if (!/^https?:$/.test(u.protocol)) return resolve(null);
    let addr;
    try { addr = (await dns.lookup(u.hostname)).address; } catch { return resolve(null); }
    if (isPrivate(addr)) return resolve(null);

    const secure = u.protocol === 'https:';
    const port = +u.port || (secure ? 443 : 80);
    const opts = { host: addr, port, servername: u.hostname };
    const sock = secure ? tls.connect(opts) : net.connect(opts);
    let buf = Buffer.alloc(0), headerDone = false, metaint = 0, bodyStart = 0, done = false;
    const finish = (v) => { if (done) return; done = true; sock.destroy(); resolve(v); };
    const timer = setTimeout(() => finish(null), TIMEOUT_MS);
    sock.on('error', () => finish(null));
    sock.on('close', () => { clearTimeout(timer); finish(null); });
    sock.on(secure ? 'secureConnect' : 'connect', () => {
      sock.write(`GET ${u.pathname}${u.search} HTTP/1.0\r\nHost: ${u.host}\r\nIcy-MetaData: 1\r\n` +
        `User-Agent: TMedia/1.4\r\nAccept: */*\r\nConnection: close\r\n\r\n`);
    });
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length > MAX_BYTES) return finish(null);
      if (!headerDone) {
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) return;
        headerDone = true;
        const head = buf.slice(0, end).toString('latin1');
        bodyStart = end + 4;
        const status = +((head.match(/^\S+\s+(\d{3})/) || [])[1] || 0);  // HTTP/1.x sau „ICY 200 OK"
        const loc = (head.match(/\r\nlocation:\s*(.+)/i) || [])[1];
        if (status >= 300 && status < 400 && loc && redirects < 3) {
          clearTimeout(timer); done = true; sock.destroy();
          return readIcy(new URL(loc.trim(), u).toString(), redirects + 1).then(resolve);
        }
        metaint = +((head.match(/\r\nicy-metaint:\s*(\d+)/i) || [])[1] || 0);
        if (status !== 200 || !metaint || metaint > MAX_BYTES) return finish(null);
      }
      const need = bodyStart + metaint + 1;
      if (buf.length < need) return;
      const len = buf[bodyStart + metaint] * 16;
      if (len === 0) return finish('');
      if (buf.length < need + len) return;
      const meta = buf.slice(need, need + len).toString('utf8').replace(/\0+$/, '');
      const m = meta.match(/StreamTitle='(.*?)';/);
      finish(m ? m[1].trim() : '');
    });
  });
}

module.exports = async (req, res) => {
  const url = (req.query && req.query.url) || '';
  let title = null;
  if (url && url.length < 2048) {
    try { title = await readIcy(url); } catch { title = null; }
  }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  // Cache scurt pe CDN: toți ascultătorii aceluiași post împart aceeași cerere
  res.setHeader('Cache-Control', 'public, s-maxage=20, stale-while-revalidate=20');
  res.status(200).send(JSON.stringify({ title: title || null }));
};

module.exports.readIcy = readIcy;
