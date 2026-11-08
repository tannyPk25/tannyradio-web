// Sincronizare favorite între dispozitive printr-un cod de 6 caractere.
//   GET  /api/sync?status=1      → { enabled: bool }  (feature activ doar dacă există Blob store)
//   POST /api/sync  {favorites, favItems}  → { code: "K7M2QX" }
//   GET  /api/sync?code=K7M2QX   → { favorites, favItems }
// Datele se țin într-un Vercel Blob store PRIVAT (nu sunt accesibile direct din internet).
const crypto = require('crypto');

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // fără 0/O, 1/I/L — ușor de tastat pe TV
const MAX_BODY = 300 * 1024;

function newCode() {
  const b = crypto.randomBytes(6);
  return Array.from(b, (x) => ALPHABET[x % ALPHABET.length]).join('');
}
const path = (code) => `sync/${code}.json`;

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > MAX_BODY) throw new Error('too large'); chunks.push(c); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function clean(data) {
  const out = { favorites: { tv: [], radio: [] }, favItems: { tv: {}, radio: {} } };
  for (const t of ['tv', 'radio']) {
    const ids = Array.isArray(data?.favorites?.[t]) ? data.favorites[t] : [];
    out.favorites[t] = ids.filter((x) => typeof x === 'string' && x.length < 200).slice(0, 500);
    const items = data?.favItems?.[t] || {};
    for (const id of out.favorites[t]) {
      const it = items[id];
      if (it && typeof it === 'object') {
        out.favItems[t][id] = {
          id, name: String(it.name || '').slice(0, 200), url: String(it.url || '').slice(0, 2048),
          logo: String(it.logo || '').slice(0, 2048), country: String(it.country || '').slice(0, 10),
          tags: String(it.tags || '').slice(0, 300), bitrate: +it.bitrate || 0, _type: t,
        };
      }
    }
  }
  return out;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const enabled = !!process.env.BLOB_READ_WRITE_TOKEN;
  if (req.method === 'GET' && req.query.status) return res.status(200).json({ enabled });
  if (!enabled) return res.status(503).json({ error: 'Sincronizarea nu este activată' });

  const { put, get } = await import('@vercel/blob');
  try {
    if (req.method === 'POST') {
      const data = clean(await readBody(req));
      for (let i = 0; i < 5; i++) {
        const code = newCode();
        if (await get(path(code), { access: 'private' })) continue; // cod deja folosit
        await put(path(code), JSON.stringify({ ...data, at: Date.now() }), {
          access: 'private', addRandomSuffix: false, contentType: 'application/json',
        });
        return res.status(200).json({ code });
      }
      return res.status(500).json({ error: 'Nu s-a putut genera un cod' });
    }
    if (req.method === 'GET') {
      const code = String(req.query.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (code.length !== 6) return res.status(400).json({ error: 'Cod invalid' });
      const r = await get(path(code), { access: 'private', useCache: false });
      if (!r) return res.status(404).json({ error: 'Cod inexistent' });
      const text = await new Response(r.stream).text();
      return res.status(200).json(clean(JSON.parse(text)));
    }
    return res.status(405).json({ error: 'Metodă nepermisă' });
  } catch (e) {
    return res.status(500).json({ error: 'Eroare sincronizare' });
  }
};
