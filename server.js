/**
 * Elit Scraper Service – Railway deployment v2
 * Navigeert via het Elit-menu na login, geen vaste sessie-URL nodig.
 */

'use strict';

const http      = require('http');
const puppeteer = require('puppeteer');

const PORT   = process.env.PORT   || 3099;
const SECRET = process.env.SECRET || '';

const LOGIN_URL = 'https://elit.tennisvlaanderen.be/ords/f?p=100:LOGIN_DESKTOP:0';

let cache     = null;
let cacheTime = 0;
const CACHE_TTL = 15 * 60 * 1000;

function log(level, msg) {
  console.log(`[${new Date().toISOString()}] [${level}] ${msg}`);
}
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

async function scrapeElit(username, password) {
  log('INFO', `Start scrape voor: ${username}`);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-gpu', '--disable-extensions', '--no-first-run',
      '--disable-accelerated-2d-canvas',
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    // ── Stap 1: Login ─────────────────────────────────────
    log('INFO', 'Loginpagina laden...');
    await page.goto(LOGIN_URL, { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForSelector('input', { timeout: 10000 });

    for (const sel of ['input[name="P100_USERNAME"]', '#P100_USERNAME', 'input[type="text"]']) {
      try { await page.waitForSelector(sel, { timeout: 2000 }); await page.click(sel, { clickCount: 3 }); await page.type(sel, username, { delay: 40 }); log('INFO', `Username: ${sel}`); break; } catch(e) {}
    }
    for (const sel of ['input[name="P100_PASSWORD"]', '#P100_PASSWORD', 'input[type="password"]']) {
      try { await page.waitForSelector(sel, { timeout: 2000 }); await page.click(sel, { clickCount: 3 }); await page.type(sel, password, { delay: 40 }); log('INFO', `Password: ${sel}`); break; } catch(e) {}
    }

    let clicked = false;
    for (const sel of ['button[type="submit"]', 'input[type="submit"]', 'button.t-Button--hot', 'button']) {
      try { await page.waitForSelector(sel, { timeout: 2000 }); await page.click(sel); clicked = true; break; } catch(e) {}
    }
    if (!clicked) await page.keyboard.press('Enter');

    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 25000 });
    const urlNaLogin = page.url();
    log('INFO', `URL na login: ${urlNaLogin}`);
    if (urlNaLogin.includes('LOGIN_DESKTOP')) throw new Error('Login mislukt. Controleer gebruikersnaam en wachtwoord.');
    log('INFO', 'Login geslaagd!');
    await wait(2000);

    // ── Stap 2: Navigeer naar inschrijvingen ──────────────
    // Haal sessie-ID op uit huidige URL en bouw doelURL
    const currentUrl = page.url();
    log('INFO', `Huidige URL: ${currentUrl}`);

    // Probeer app 111 (inschrijvingen-module) met huidige sessie
    const sessionMatch = currentUrl.match(/:(\d{10,})/);
    if (sessionMatch) {
      const sessionId = sessionMatch[1];
      const targetUrl = `https://elit.tennisvlaanderen.be/ords/f?p=111:44:${sessionId}:::44,CIR::`;
      log('INFO', `Navigeer naar inschrijvingen: ${targetUrl}`);
      await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 30000 });
      await wait(3000);
    } else {
      // Fallback: zoek menu-link
      log('INFO', 'Geen sessie-ID, zoek menu-link...');
      const regLink = await page.evaluate(() => {
        const kws = ['inschrijv', 'training', 'lessen', 'stages', 'registrat'];
        for (const a of document.querySelectorAll('a[href]')) {
          const t = (a.innerText || '').toLowerCase();
          const h = a.href || '';
          if (kws.some(k => t.includes(k)) || h.includes('p=111')) return h;
        }
        return null;
      });
      if (regLink) {
        log('INFO', `Menu-link gevonden: ${regLink}`);
        await page.goto(regLink, { waitUntil: 'networkidle2', timeout: 30000 });
        await wait(3000);
      }
    }

    log('INFO', `Pagina na navigatie: ${page.url()}`);

    // ── Stap 3: Data ophalen (incl. meerdere tabs) ────────
    const allData = await extractAllRegistrations(page);
    log('INFO', `Totaal: ${allData.length} rijen`);

    const htmlFallback = allData.length === 0 ? await page.content() : null;
    await browser.close();

    return { success: true, registrations: allData, html_fallback: htmlFallback, url: page.url(), count: allData.length };

  } catch (err) {
    log('ERROR', err.message);
    try { await browser.close(); } catch(e) {}
    throw err;
  }
}

async function extractAllRegistrations(page) {
  let allRows = [];

  // Eerste tab
  const batch1 = await extractTableData(page);
  log('INFO', `Actieve tab: ${batch1.length} rijen`);
  allRows = allRows.concat(batch1);

  // Zoek extra tabs
  const tabSelectors = [
    '.t-TabsRegion-items li a',
    '.t-Tabs-item a',
    '[role="tab"]',
    '.a-Tabs-item a',
    'li.t-NavTabs-item a',
  ];

  let tabs = [];
  for (const sel of tabSelectors) {
    tabs = await page.$$(sel);
    if (tabs.length > 1) break;
  }

  log('INFO', `Tabs gevonden: ${tabs.length}`);

  for (let i = 1; i < tabs.length; i++) {
    try {
      const tabText = await page.evaluate(el => el.innerText || el.textContent || '', tabs[i]);
      log('INFO', `Tab ${i} klikken: "${tabText.trim()}"`);
      await tabs[i].click();
      await wait(2500);
      const batch = await extractTableData(page);
      log('INFO', `Tab "${tabText.trim()}": ${batch.length} rijen`);
      allRows = allRows.concat(batch);
    } catch(e) {
      log('WARN', `Tab ${i} fout: ${e.message}`);
    }
  }

  // Dedup
  const seen = new Set();
  return allRows.filter(row => {
    const key = JSON.stringify(row);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function extractTableData(page) {
  return await page.evaluate(() => {
    const rows = [];

    // Methode 1: HTML tabellen
    document.querySelectorAll('table').forEach(table => {
      const headers = [];
      table.querySelectorAll('thead th, thead td').forEach(h => headers.push(h.innerText.trim()));
      if (headers.length < 2) {
        // Probeer eerste rij als header
        const firstRow = table.querySelector('tr');
        if (firstRow) firstRow.querySelectorAll('th, td').forEach(h => headers.push(h.innerText.trim()));
      }
      if (headers.length < 2) return;

      table.querySelectorAll('tbody tr').forEach(tr => {
        const cells = tr.querySelectorAll('td');
        if (cells.length < 2) return;
        const obj = {};
        cells.forEach((td, i) => { obj[headers[i] || 'col_' + i] = td.innerText.trim(); });
        if (Object.values(obj).filter(v => v).length >= 2) rows.push(obj);
      });
    });

    // Methode 2: APEX IR
    if (rows.length === 0) {
      const tbl = document.querySelector('.a-IRR-table, .t-Report table, .apex-rpt-table');
      if (tbl) {
        const headers = [];
        tbl.querySelectorAll('th').forEach(th => headers.push(th.innerText.trim()));
        tbl.querySelectorAll('tbody tr').forEach(tr => {
          const obj = {};
          tr.querySelectorAll('td').forEach((td, i) => { obj[headers[i] || 'col_' + i] = td.innerText.trim(); });
          if (Object.values(obj).some(v => v)) rows.push(obj);
        });
      }
    }

    return rows;
  });
}

// ── HTTP Server ───────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'elit-scraper', version: '2.0' }));
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
    catch(e) { res.writeHead(400); res.end(JSON.stringify({ error: 'Ongeldige JSON.' })); return; }

    if (SECRET && payload.secret !== SECRET) {
      log('WARN', 'Ongeldig secret.');
      res.writeHead(403); res.end(JSON.stringify({ error: 'Toegang geweigerd.' })); return;
    }

    const { username, password, force_refresh } = payload;
    if (!username || !password) {
      res.writeHead(400); res.end(JSON.stringify({ error: 'username en password verplicht.' })); return;
    }

    if (!force_refresh && cache && (Date.now() - cacheTime < CACHE_TTL)) {
      log('INFO', 'Cache hit.');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ...cache, from_cache: true }));
      return;
    }

    try {
      const result = await scrapeElit(username, password);
      cache = result; cacheTime = Date.now();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ...result, from_cache: false }));
    } catch(err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message, success: false }));
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  log('INFO', `Elit Scraper Service v2 actief op poort ${PORT}`);
  if (!SECRET) log('WARN', 'Geen SECRET ingesteld!');
});

process.on('unhandledRejection', reason => log('ERROR', String(reason)));
