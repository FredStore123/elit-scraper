/**
 * Elit Scraper Service – v4
 * Na login: navigeert via het menu zoals een echte gebruiker.
 * Geen hardcoded URLs meer naar app 111.
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
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
           '--disable-gpu','--disable-extensions','--no-first-run','--disable-accelerated-2d-canvas'],
  });
}

async function doLogin(page, username, password) {
  log('INFO', 'Loginpagina laden...');
  await page.goto(LOGIN_URL, { waitUntil: 'networkidle2', timeout: 30000 });
  await page.waitForSelector('input', { timeout: 10000 });

  for (const sel of ['input[name="P100_USERNAME"]','#P100_USERNAME','input[type="text"]']) {
    try { await page.waitForSelector(sel,{timeout:2000}); await page.click(sel,{clickCount:3}); await page.type(sel,username,{delay:40}); log('INFO',`User: ${sel}`); break; } catch(e){}
  }
  for (const sel of ['input[name="P100_PASSWORD"]','#P100_PASSWORD','input[type="password"]']) {
    try { await page.waitForSelector(sel,{timeout:2000}); await page.click(sel,{clickCount:3}); await page.type(sel,password,{delay:40}); log('INFO',`Pass: ${sel}`); break; } catch(e){}
  }
  let clicked = false;
  for (const sel of ['button[type="submit"]','input[type="submit"]','button.t-Button--hot','button']) {
    try { await page.waitForSelector(sel,{timeout:2000}); await page.click(sel); clicked=true; break; } catch(e){}
  }
  if (!clicked) await page.keyboard.press('Enter');

  await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 25000 });
  const url = page.url();
  log('INFO', `URL na login: ${url}`);
  if (url.includes('LOGIN_DESKTOP')) throw new Error('Login mislukt. Controleer gebruikersnaam en wachtwoord.');
  log('INFO', 'Login geslaagd!');
  await wait(2000);
}

// Navigeer naar inschrijvingen door op een menulink te klikken
async function navigateToRegistrations(page) {
  log('INFO', 'Zoeken naar inschrijvingen in menu...');

  // Haal alle links op van de huidige pagina
  const links = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('a[href]')).map(a => ({
      text: (a.innerText || a.textContent || '').trim().toLowerCase(),
      href: a.href,
    }));
  });

  log('INFO', `Totaal links op pagina: ${links.length}`);
  links.slice(0, 20).forEach(l => log('INFO', `  Link: "${l.text}" → ${l.href}`));

  // Zoek de beste match
  const keywords = ['inschrijv', 'training', 'lessen', 'stages', 'cursus', 'les ', 'stage'];
  let bestLink = null;

  for (const kw of keywords) {
    bestLink = links.find(l => l.text.includes(kw) || (l.href.includes('p=111') && !l.href.includes('LOGIN')));
    if (bestLink) { log('INFO', `Match op "${kw}": ${bestLink.href}`); break; }
  }

  if (!bestLink) {
    // Fallback: alle links met p=111 in href
    bestLink = links.find(l => l.href.includes('f?p=111'));
    if (bestLink) log('INFO', `Fallback p=111 link: ${bestLink.href}`);
  }

  if (bestLink) {
    log('INFO', `Navigeer naar: ${bestLink.href}`);
    await page.goto(bestLink.href, { waitUntil: 'networkidle2', timeout: 30000 });
    await wait(3000);
    log('INFO', `Na navigatie: ${page.url()}`);
    return true;
  }

  log('WARN', 'Geen inschrijvingen-link gevonden in menu.');
  return false;
}

// Debug: login + screenshot na login (vóór navigatie naar inschrijvingen)
async function debugAfterLogin(username, password) {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    await doLogin(page, username, password);

    // Screenshot DIRECT na login (startpagina)
    const screenshotLogin = await page.screenshot({ encoding: 'base64', fullPage: false });
    const urlLogin = page.url();

    // Alle links verzamelen
    const allLinks = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a[href]')).map(a => ({
        text: (a.innerText || a.textContent || '').trim(),
        href: a.href,
      })).filter(l => l.text || l.href).slice(0, 50)
    );

    const headings = await page.evaluate(() =>
      Array.from(document.querySelectorAll('h1,h2,h3,h4,.t-NavigationBar-link,.t-TreeNav-label'))
        .map(el => el.innerText.trim()).filter(t => t).slice(0, 20)
    );

    const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 800));

    // Nu ook proberen te navigeren naar inschrijvingen
    const navSuccess = await navigateToRegistrations(page);
    const screenshotNav = await page.screenshot({ encoding: 'base64', fullPage: false });
    const urlNav = page.url();
    const bodyNav = await page.evaluate(() => document.body.innerText.slice(0, 800));
    const tablesNav = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('table')).map(t => ({
        rows: t.querySelectorAll('tr').length,
        headers: Array.from(t.querySelectorAll('th')).map(th => th.innerText.trim()),
      }));
    });

    await browser.close();
    return {
      success: true,
      // Na login
      url_login: urlLogin,
      screenshot_login: screenshotLogin,
      headings,
      all_links: allLinks,
      body_login: bodyText,
      // Na navigatie
      nav_success: navSuccess,
      url_nav: urlNav,
      screenshot_nav: screenshotNav,
      body_nav: bodyNav,
      tables_nav: tablesNav,
    };
  } catch(err) {
    try { await browser.close(); } catch(e) {}
    throw err;
  }
}

// Scrape
async function scrapeElit(username, password) {
  log('INFO', `Start scrape voor: ${username}`);
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    await doLogin(page, username, password);
    await navigateToRegistrations(page);

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
  const b1 = await extractTable(page);
  log('INFO', `Tab 1: ${b1.length} rijen`);
  all = all.concat(b1);

  const tabEls = await page.$$([
    '.t-TabsRegion-items li:not(.is-active) a',
    '.t-Tabs-item:not(.is-active) a',
    '[role="tab"]:not([aria-selected="true"])',
  ].join(', '));

  log('INFO', `Extra tabs: ${tabEls.length}`);
  for (const tab of tabEls) {
    try {
      const txt = await page.evaluate(el => el.innerText || '', tab);
      log('INFO', `Tab: "${txt.trim()}"`);
      await tab.click();
      await wait(2500);
      const batch = await extractTable(page);
      log('INFO', `  → ${batch.length} rijen`);
      all = all.concat(batch);
    } catch(e) { log('WARN', `Tab fout: ${e.message}`); }
  }

  const seen = new Set();
  return all.filter(r => { const k=JSON.stringify(r); if(seen.has(k)) return false; seen.add(k); return true; });
}

async function extractTable(page) {
  return page.evaluate(() => {
    const rows = [];
    document.querySelectorAll('table').forEach(table => {
      const headers = [];
      table.querySelectorAll('thead th, thead td').forEach(h => { if(h.innerText.trim()) headers.push(h.innerText.trim()); });
      if (headers.length === 0) {
        const fr = table.querySelector('tr');
        if (fr) fr.querySelectorAll('th,td').forEach(c => { if(c.innerText.trim()) headers.push(c.innerText.trim()); });
      }
      if (headers.length < 2) return;
      table.querySelectorAll('tbody tr').forEach(tr => {
        const cells = tr.querySelectorAll('td');
        if (cells.length < 2) return;
        const obj = {};
        cells.forEach((td,i) => { obj[headers[i]||'col_'+i] = td.innerText.trim(); });
        if (Object.values(obj).filter(v=>v).length >= 2) rows.push(obj);
      });
    });
    return rows;
  });
}

// HTTP Server
const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({ status:'ok', version:'4.0' }));
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(404); res.end(JSON.stringify({error:'Not found'})); return;
  }

  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', async () => {
    let payload;
    try { payload = JSON.parse(body); }
    catch(e) { res.writeHead(400); res.end(JSON.stringify({error:'Ongeldige JSON.'})); return; }

    if (SECRET && payload.secret !== SECRET) {
      res.writeHead(403); res.end(JSON.stringify({error:'Toegang geweigerd.'})); return;
    }
    const { username, password, force_refresh } = payload;
    if (!username || !password) {
      res.writeHead(400); res.end(JSON.stringify({error:'username en password verplicht.'})); return;
    }

    if (req.url === '/debug') {
      try {
        const result = await debugAfterLogin(username, password);
        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify(result));
      } catch(err) {
        res.writeHead(500); res.end(JSON.stringify({error: err.message}));
      }
      return;
    }

    if (req.url === '/scrape') {
      if (!force_refresh && cache && (Date.now()-cacheTime < CACHE_TTL)) {
        res.writeHead(200,{'Content-Type':'application/json'});
        res.end(JSON.stringify({...cache, from_cache:true})); return;
      }
      try {
        const result = await scrapeElit(username, password);
        cache = result; cacheTime = Date.now();
        res.writeHead(200,{'Content-Type':'application/json'});
        res.end(JSON.stringify({...result, from_cache:false}));
      } catch(err) {
        res.writeHead(500); res.end(JSON.stringify({error:err.message, success:false}));
      }
      return;
    }

    res.writeHead(404); res.end(JSON.stringify({error:'Endpoint niet gevonden.'}));
  });
});

server.listen(PORT, '0.0.0.0', () => {
  log('INFO', `Elit Scraper v4 actief op poort ${PORT}`);
  if (!SECRET) log('WARN', 'Geen SECRET!');
});
process.on('unhandledRejection', r => log('ERROR', String(r)));
