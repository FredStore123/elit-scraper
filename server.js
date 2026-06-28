/**
 * Elit Scraper Service – Railway deployment
 * Headless Chromium logt in op elit.tennisvlaanderen.be en haalt inschrijvingen op.
 */

'use strict';

const http      = require('http');
const puppeteer = require('puppeteer');
const crypto    = require('crypto');

const PORT   = process.env.PORT   || 3099;
const SECRET = process.env.SECRET || '';

const LOGIN_URL = 'https://elit.tennisvlaanderen.be/ords/f?p=100:LOGIN_DESKTOP:0';
const REG_URL   = 'https://elit.tennisvlaanderen.be/ords/f?p=111:44::::44,CIR::';

// Eenvoudige in-memory cache (15 minuten)
let cache = null;
let cacheTime = 0;
const CACHE_TTL = 15 * 60 * 1000;

function log(level, msg) {
  console.log(`[${new Date().toISOString()}] [${level}] ${msg}`);
}

async function scrapeElit(username, password) {
  log('INFO', `Start scrape voor: ${username}`);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-extensions',
      '--no-first-run',
      '--single-process',
      '--disable-accelerated-2d-canvas',
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    // ── Stap 1: Loginpagina ────────────────────────────────
    log('INFO', 'Loginpagina laden...');
    await page.goto(LOGIN_URL, { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForSelector('input', { timeout: 10000 });

    // ── Stap 2: Inloggen ───────────────────────────────────
    log('INFO', 'Inlogvelden invullen...');

    // Gebruikersnaam
    const userSelectors = [
      'input[name="P100_USERNAME"]',
      '#P100_USERNAME',
      'input[type="text"]',
    ];
    for (const sel of userSelectors) {
      try {
        await page.waitForSelector(sel, { timeout: 2000 });
        await page.click(sel, { clickCount: 3 });
        await page.type(sel, username, { delay: 40 });
        log('INFO', `Gebruikersnaam ingevuld: ${sel}`);
        break;
      } catch(e) {}
    }

    // Wachtwoord
    const passSelectors = [
      'input[name="P100_PASSWORD"]',
      '#P100_PASSWORD',
      'input[type="password"]',
    ];
    for (const sel of passSelectors) {
      try {
        await page.waitForSelector(sel, { timeout: 2000 });
        await page.click(sel, { clickCount: 3 });
        await page.type(sel, password, { delay: 40 });
        log('INFO', `Wachtwoord ingevuld: ${sel}`);
        break;
      } catch(e) {}
    }

    // Login-knop klikken
    const btnSelectors = [
      'button[type="submit"]',
      'input[type="submit"]',
      'button.t-Button--hot',
      'button',
    ];
    let clicked = false;
    for (const sel of btnSelectors) {
      try {
        await page.waitForSelector(sel, { timeout: 2000 });
        await page.click(sel);
        clicked = true;
        log('INFO', `Login-knop geklikt: ${sel}`);
        break;
      } catch(e) {}
    }
    if (!clicked) {
      await page.keyboard.press('Enter');
      log('INFO', 'Login via Enter');
    }

    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 });

    const urlNaLogin = page.url();
    log('INFO', `URL na login: ${urlNaLogin}`);

    if (urlNaLogin.includes('LOGIN_DESKTOP')) {
      const fout = await page.evaluate(() => {
        const el = document.querySelector('.t-Alert--danger, .apex-error, [class*="error"]');
        return el ? el.innerText : null;
      });
      throw new Error('Login mislukt' + (fout ? ': ' + fout.trim() : '. Controleer gebruikersnaam/wachtwoord.'));
    }

    log('INFO', 'Login geslaagd!');

    // ── Stap 3: Inschrijvingen pagina ──────────────────────
    log('INFO', 'Navigeren naar inschrijvingen...');
    await page.goto(REG_URL, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 2000));

    const regUrl = page.url();
    log('INFO', `Inschrijvingen URL: ${regUrl}`);

    // ── Stap 4: Data uitlezen ──────────────────────────────
    const data = await page.evaluate(() => {
      const rows = [];

      // Probeer standaard HTML-tabellen
      document.querySelectorAll('table').forEach(table => {
        const headers = [];
        const headerRow = table.querySelector('thead tr, tr:first-child');
        if (headerRow) {
          headerRow.querySelectorAll('th, td').forEach(h => headers.push(h.innerText.trim()));
        }
        if (headers.length < 3) return;

        table.querySelectorAll('tbody tr, tr').forEach((row, i) => {
          if (i === 0 && row.querySelectorAll('th').length > 0) return;
          const cells = row.querySelectorAll('td');
          if (cells.length < 2) return;
          const obj = {};
          cells.forEach((td, j) => { obj[headers[j] || 'col_' + j] = td.innerText.trim(); });
          if (Object.values(obj).some(v => v !== '')) rows.push(obj);
        });
      });

      // Fallback: APEX Interactive Report divs
      if (rows.length === 0) {
        const irHeaders = [];
        document.querySelectorAll('.a-IRR-table th, .t-Report-wrap th').forEach(th => {
          irHeaders.push(th.innerText.trim());
        });
        document.querySelectorAll('.a-IRR-table tbody tr, .t-Report-wrap tbody tr').forEach(tr => {
          const obj = {};
          tr.querySelectorAll('td').forEach((td, i) => {
            obj[irHeaders[i] || 'col_' + i] = td.innerText.trim();
          });
          if (Object.values(obj).some(v => v !== '')) rows.push(obj);
        });
      }

      return rows;
    });

    const htmlFallback = data.length === 0 ? await page.content() : null;

    log('INFO', `Data: ${data.length} rijen gevonden`);
    await browser.close();

    return {
      success      : true,
      registrations: data,
      html_fallback: htmlFallback,
      url          : regUrl,
      count        : data.length,
    };

  } catch (err) {
    log('ERROR', err.message);
    try { await browser.close(); } catch(e) {}
    throw err;
  }
}

// ── HTTP Server ───────────────────────────────────────────
const server = http.createServer(async (req, res) => {

  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'elit-scraper' }));
    return;
  }

  if (req.method !== 'POST' || req.url !== '/scrape') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', async () => {
    let payload;
    try { payload = JSON.parse(body); }
    catch(e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Ongeldige JSON.' }));
      return;
    }

    // Secret check
    if (SECRET && payload.secret !== SECRET) {
      log('WARN', 'Ongeldig secret.');
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Toegang geweigerd.' }));
      return;
    }

    const { username, password, force_refresh } = payload;
    if (!username || !password) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'username en password zijn verplicht.' }));
      return;
    }

    // Cache
    if (!force_refresh && cache && (Date.now() - cacheTime < CACHE_TTL)) {
      log('INFO', 'Cache hit.');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ...cache, from_cache: true }));
      return;
    }

    try {
      const result = await scrapeElit(username, password);
      cache = result;
      cacheTime = Date.now();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ...result, from_cache: false }));
    } catch(err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message, success: false }));
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  log('INFO', `Elit Scraper Service actief op poort ${PORT}`);
  if (!SECRET) {
    log('WARN', 'Geen SECRET ingesteld! Stel de SECRET omgevingsvariabele in op Railway.');
  }
});

process.on('unhandledRejection', reason => log('ERROR', String(reason)));
