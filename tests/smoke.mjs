// Test de fum TMedia: pornește site-ul local și verifică funcțiile critice în Chrome.
// Rulare: node tests/smoke.mjs   (CHROME_PATH poate indica executabilul Chrome)
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const PORT = 8799;
const CHROME = process.env.CHROME_PATH || [
  '/usr/bin/google-chrome', '/usr/bin/chromium-browser',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].find((p) => fs.existsSync(p));

let failed = 0;
const ok = (cond, name, extra = '') => {
  console.log(`${cond ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failed++;
};

const server = spawn(process.platform === 'win32' ? 'python' : 'python3',
  ['-m', 'http.server', String(PORT)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 1500));

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
try {
  // ---------- Desktop ----------
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof state !== 'undefined', { timeout: 15000 });

  const unit = await page.evaluate(() => ({
    m3u: parseM3U('#EXTM3U\n#EXTINF:-1 tvg-id="x" group-title="News,Sports",Digi 24 HD\nhttp://a/b.m3u8\n')[0]?.name,
    fold: [_fold('Pro-B'), _fold('pro b'), _fold('România Actualități')],
    dedup: dedupStations([
      { name: 'Radio Pro-B', url: 'http://x/s', clickcount: 1, bitrate: 128 },
      { name: 'ProB Radio', url: 'http://x/s', clickcount: 6, bitrate: 320 },
    ]).map((s) => s.name),
    upgrade: (typeof upgradeUrl === 'function'),
  }));
  ok(unit.m3u === 'Digi 24 HD', 'parseM3U păstrează numele când group-title are virgulă', unit.m3u);
  ok(unit.fold[0] === 'prob' && unit.fold[1] === 'prob' && unit.fold[2] === 'romaniaactualitati', 'căutare tolerantă (_fold)', unit.fold.join(','));
  ok(unit.dedup.length === 1 && unit.dedup[0] === 'ProB Radio', 'dedup radio păstrează postul popular', unit.dedup.join(','));

  const tabPrevented = await page.evaluate(() => {
    const e = new KeyboardEvent('keydown', { code: 'Tab', key: 'Tab', bubbles: true, cancelable: true });
    document.body.dispatchEvent(e); return e.defaultPrevented;
  });
  ok(!tabPrevented, 'Tab nu e blocat pe desktop');

  // Lista TV se încarcă (depinde de iptv-org — tolerăm rețea lentă)
  const tvLoaded = await page.waitForFunction(() => state.tvList.length > 0, { timeout: 45000 }).then(() => true, () => false);
  ok(tvLoaded, 'lista TV se încarcă');
  // ---------- Funcții 1.6: ultimul canal, coadă, favorite, ascundere + PIN ----------
  const f16 = await page.evaluate(async () => {
    const r = {};
    const [a, b2, c] = state.tvList;
    // play() poate porni redarea; ne interesează doar logica de listă
    state.mode = 'tv'; state.tvOnlyWorking = false; applyFilter();
    state.queue = state.filtered.slice();
    play(a); play(b2);
    r.prevIsA = state.prevItem && state.prevItem.id === a.id;
    r.lastOk = window.__broadcastLast() && state.current.id === a.id;
    // favorite: adaug 3, mut al treilea în sus
    state.favorites = { tv: [], radio: [] }; state.favItems = { tv: {}, radio: {} };
    [a, b2, c].forEach(x => toggleFavorite(x, 'tv'));
    await switchMode('fav');
    const third = state.filtered[2];
    editAction(third, null, 'up');
    r.reorder = state.favorites.tv[1] === c.id;
    // ascundere + PIN
    await switchMode('tv');
    const victim = state.filtered[0];
    editAction(victim, null, 'hide');
    r.hidden = !state.filtered.some(x => x.id === victim.id);
    SETTINGS.pinHash = _pinHash('1234');
    setTimeout(() => { $('pin-input').value = '0000'; $('pin-ok').click(); }, 50);
    r.wrongPin = (await requirePin('test')) === false;
    setTimeout(() => { $('pin-input').value = '1234'; $('pin-ok').click(); }, 50);
    r.goodPin = (await requirePin('test')) === true;
    HIDDEN.tv = []; SETTINGS.pinHash = ''; saveHidden(); saveSettings(); applyFilter();
    r.unhidden = state.filtered.some(x => x.id === victim.id);
    stopAll();
    return r;
  });
  ok(f16.prevIsA && f16.lastOk, 'Back: revine la canalul anterior', JSON.stringify(f16));
  ok(f16.reorder, 'favoritele se pot reordona');
  ok(f16.hidden && f16.unhidden, 'canalele se pot ascunde și readuce');
  ok(f16.wrongPin && f16.goodPin, 'PIN: refuză PIN greșit, acceptă PIN corect');

  ok(errors.length === 0, 'fără erori JavaScript (desktop)', errors.join(' | '));

  // ---------- TV (telecomandă) ----------
  const tv = await browser.newPage();
  const tvErrors = [];
  tv.on('pageerror', (e) => tvErrors.push(e.message));
  await tv.setViewport({ width: 900, height: 540 });
  await tv.setUserAgent('Mozilla/5.0 (Linux; Android 12; MiTV) AppleWebKit/537.36 Chrome/120 Safari/537.36 TannyRadioTV');
  await tv.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await tv.waitForFunction(() => typeof state !== 'undefined' && document.querySelector('#channel-list .channel'), { timeout: 45000 }).catch(() => {});
  const key = (k) => tv.evaluate((k) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, code: k, bubbles: true, cancelable: true })), k);
  await tv.evaluate(() => _tvFocusTabs(0));
  await key('ArrowRight');
  const onRadioTab = await tv.evaluate(() => document.activeElement.id);
  await key('Enter');
  const radioOk = await tv.waitForFunction(() => state.mode === 'radio', { timeout: 10000 }).then(() => true, () => false);
  ok(onRadioTab === 'mode-radio' && radioOk, 'telecomanda comută pe RADIO', onRadioTab);
  ok(tvErrors.length === 0, 'fără erori JavaScript (TV)', tvErrors.join(' | '));
} finally {
  await browser.close();
  server.kill();
}

// ---------- API nowplaying: nu poate fi folosit spre rețele interne ----------
const { readIcy } = require('../api/nowplaying.js');
ok((await readIcy('http://127.0.0.1/x')) === null, 'nowplaying blochează localhost');
ok((await readIcy('http://192.168.1.1/x')) === null, 'nowplaying blochează rețele private');
ok((await readIcy('ftp://example.com/x')) === null, 'nowplaying acceptă doar http/https');

console.log(failed ? `\n${failed} test(e) au eșuat` : '\nToate testele au trecut');
process.exit(failed ? 1 : 0);
