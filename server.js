/**
 * Elit Scraper Service – v3
 * Extra /debug endpoint: maakt screenshot + geeft HTML terug zodat we zien wat Puppeteer ziet.
 */
'use strict';

const http      = require('http');
const puppeteer = require('puppeteer');

const PORT   = process.env.PORT   || 3099;
const SECRET = process.env.SECRET || '';

const LOGIN_URL = 'https://elit.tennisvlaanderen.be/ords/f?p=100:LOGIN_DESKTOP:0';

let cache = null, cacheTime = 0;
const CACHE_TTL = 15 * 60 * 1000;

function log(level, msg) { console.log(`[${new Date().toISOString()}] [${level}] ${msg}`); }
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

async function launchBrowser() {
  return puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-gpu', '--disable-extensions', '--no-first-run',
      '--disable-accelerated-2d-canvas',
    ],
  });
}

async function loginAndNavigate(page, username, password) {
  // Login
  log('INFO', 'Loginpagina laden...');
  await page.goto(LOGIN_URL, { waitUntil: 'networkidle2', timeout: 30000 });
  await page.waitForSelector('input', { timeout: 10000 });

  for (const sel of ['input[name="P100_USERNAME"]', '#P100_USERNAME', 'input[type="text"]']) {
    try { await page.waitForSelector(sel, { timeout: 2000 }); await page.click(sel, { clickCount: 3 }); await page.type(sel, username, { delay: 40 }); log('INFO', `Username via ${sel}`); break; } catch(e) {}
  }
  for (const sel of ['input[name="P100_PASSWORD"]', '#P100_PASSWORD', 'input[type="password"]']) {
    try { await page.waitForSelector(sel, { timeout: 2000 }); await page.click(sel, { clickCount: 3 }); await page.type(sel, password, { delay: 40 }); log('INFO', `Password via ${sel}`); break; } catch(e) {}
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

  // Navigeer naar inschrijvingen-module (app 111, pagina 44)
  const currentUrl = page.url();
  const sessionMatch = currentUrl.match(/:(\d{10,})/);
  if (sessionMatch) {
    const sid = sessionMatch[1];
    const target = `https://elit.tennisvlaanderen.be/ords/f?p=111:44:${sid}:::44,CIR::`;
    log('INFO', `Navigeer met sessie ${sid}: ${target}`);
    await page.goto(target, { waitUntil: 'networkidle2', timeout: 30000 });
  } else {
    // Fallback: zoek link in menu
    const link = await page.evaluate(() => {
      for (const a of document.querySelectorAll('a[href]')) {
        const h = a.href || '';
        if (h.includes('p=111')) return h;
      }
      return null;
    });
    if (link) {
      log('INFO', `Menu-link: ${link}`);
      await page.goto(link, { waitUntil: 'networkidle2', timeout: 30000 });
    }
  }

  await wait(3000);
  log('INFO', `Na navigatie: ${page.url()}`);
}

// ── Debug: login + screenshot + HTML dump ─────────────────
async function debugScrape(username, password) {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    await loginAndNavigate(page, username, password);

    const screenshot = await page.screenshot({ encoding: 'base64', fullPage: false });
    const html       = await page.content();
    const currentUrl = page.url();

    // Analyseer de pagina: wat zit er in?
    const analysis = await page.evaluate(() => {
      const tables    = document.querySelectorAll('table');
      const links     = Array.from(document.querySelectorAll('a[href]')).slice(0, 30).map(a => ({ text: a.innerText.trim().slice(0, 50), href: a.href }));
      const buttons   = Array.from(document.querySelectorAll('button, input[type="submit"]')).map(b => b.innerText || b.value || '').slice(0, 20);
      const navItems  = Array.from(document.querySelectorAll('nav a, .t-NavigationBar a, .t-Header a, [class*="nav"] a')).map(a => ({ text: a.innerText.trim(), href: a.href })).slice(0, 20);
      const headings  = Array.from(document.querySelectorAll('h1, h2, h3')).map(h => h.innerText.trim()).slice(0, 10);
      const tableInfo = Array.from(tables).map(t => ({
        rows: t.querySelectorAll('tr').length,
        headers: Array.from(t.querySelectorAll('th')).map(th => th.innerText.trim()),
      }));
      const bodyText  = document.body.innerText.slice(0, 1000);

      return { tableCount: tables.length, tableInfo, links, buttons, navItems, headings, bodyText };
    });

    await browser.close();

    return {
      success    : true,
      url        : currentUrl,
      screenshot : screenshot,          // base64 PNG
      html_length: html.length,
      html_sample: html.slice(0, 3000), // eerste 3000 chars
      analysis,
    };
  } catch(err) {
    try { await browser.close(); } catch(e) {}
    throw err;
  }
}

// ── Scrape met slimmere tabel-detectie ────────────────────
async function scrapeElit(username, password) {
  log('INFO', `Start scrape voor: ${username}`);
  const browser = await launchBrowser();

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    await loginAndNavigate(page, username, password);

    // Haal data op van alle tabs
    const allData = await extractAllTabs(page);
    log('INFO', `Totaal: ${allData.length} rijen`);

    const htmlFallback = allData.length === 0 ? await page.content() : null;
    await browser.close();

    return { success: true, registrations: allData, html_fallback: htmlFallback, url: page.url(), count: allData.length };
  } catch(err) {
    log('ERROR', err.message);
    try { await browser.close(); } catch(e) {}
    throw err;
  }
}

async function extractAllTabs(page) {
  let all = [];

  // Lees eerste/actieve tab
  const b1 = await extractTable(page);
  log('INFO', `Tab 1: ${b1.length} rijen`);
  all = all.concat(b1);

  // Zoek andere tabs
  const tabEls = await page.$$([
    '.t-TabsRegion-items li:not(.is-active) a',
    '.t-Tabs-item:not(.is-active) a',
    '[role="tab"]:not([aria-selected="true"])',
    '.a-Tabs-item:not(.is-active) a',
  ].join(', '));

  log('INFO', `Extra tabs: ${tabEls.length}`);

  for (const tab of tabEls) {
    try {
      const txt = await page.evaluate(el => el.innerText || el.textContent || '', tab);
      log('INFO', `Tab klikken: "${txt.trim()}"`);
      await tab.click();
      await wait(2500);
      const batch = await extractTable(page);
      log('INFO', `Tab "${txt.trim()}": ${batch.length} rijen`);
      all = all.concat(batch);
    } catch(e) { log('WARN', `Tab fout: ${e.message}`); }
  }

  // Dedup
  const seen = new Set();
  return all.filter(r => { const k = JSON.stringify(r); if (seen.has(k)) return false; seen.add(k); return true; });
}

async function extractTable(page) {
  return page.evaluate(() => {
    const rows = [];

    // Alle tabellen doorlopen
    document.querySelectorAll('table').forEach(table => {
      const headers = [];

      // Probeer thead
      table.querySelectorAll('thead th, thead td').forEach(h => {
        const t = h.innerText.trim();
        if (t) headers.push(t);
      });

      // Fallback: eerste rij
      if (headers.length === 0) {
        const fr = table.querySelector('tr');
        if (fr) fr.querySelectorAll('th, td').forEach(c => { if (c.innerText.trim()) headers.push(c.innerText.trim()); });
      }

      if (headers.length < 2) return;

      table.querySelectorAll('tbody tr').forEach(tr => {
        // Sla rijen over met enkel checkboxes/buttons
        const cells = tr.querySelectorAll('td');
        if (cells.length < 2) return;
        const obj = {};
        cells.forEach((td, i) => {
          const key = headers[i] || ('col_' + i);
          // innerText geeft leesbare tekst, ook als er een link in zit
          obj[key] = td.innerText.trim();
        });
        const nonEmpty = Object.values(obj).filter(v => v && v.length > 0);
        if (nonEmpty.length >= 2) rows.push(obj);
      });
    });

    return rows;
  });
}

// ── HTTP Server ───────────────────────────────────────────
const server = http.createServer(async (req, res) => {

  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', version: '3.0' }));
    return;
  }

  if (req.method !== 'POST') {
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

    // Secret check
    if (SECRET && payload.secret !== SECRET) {
      log('WARN', 'Ongeldig secret.');
      res.writeHead(403); res.end(JSON.stringify({ error: 'Toegang geweigerd.' })); return;
    }

    const { username, password, force_refresh } = payload;
    if (!username || !password) {
      res.writeHead(400); res.end(JSON.stringify({ error: 'username en password verplicht.' })); return;
    }

    // ── /debug – geeft screenshot + analyse terug ─────────
    if (req.url === '/debug') {
      log('INFO', 'Debug-request ontvangen');
      try {
        const result = await debugScrape(username, password);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch(err) {
        res.writeHead(500); res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // ── /scrape – normale sync ────────────────────────────
    if (req.url === '/scrape') {
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
        res.writeHead(500); res.end(JSON.stringify({ error: err.message, success: false }));
      }
      return;
    }

    res.writeHead(404); res.end(JSON.stringify({ error: 'Endpoint not found.' }));
  });
});

server.listen(PORT, '0.0.0.0', () => {
  log('INFO', `Elit Scraper Service v3 actief op poort ${PORT}`);
  if (!SECRET) log('WARN', 'Geen SECRET ingesteld!');
});

process.on('unhandledRejection', reason => log('ERROR', String(reason)));
