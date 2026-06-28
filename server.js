/**
 * Elit Scraper Service – v5
 * Navigatie: Home → Training & Stages (menu) → klik "Inschrijvingen" kaart → data ophalen
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
  log('INFO', 'Login...');
  await page.goto(LOGIN_URL, { waitUntil: 'networkidle2', timeout: 30000 });
  await page.waitForSelector('input', { timeout: 10000 });

  for (const sel of ['input[name="P100_USERNAME"]','#P100_USERNAME','input[type="text"]']) {
    try { await page.waitForSelector(sel,{timeout:2000}); await page.click(sel,{clickCount:3}); await page.type(sel,username,{delay:40}); break; } catch(e){}
  }
  for (const sel of ['input[name="P100_PASSWORD"]','#P100_PASSWORD','input[type="password"]']) {
    try { await page.waitForSelector(sel,{timeout:2000}); await page.click(sel,{clickCount:3}); await page.type(sel,password,{delay:40}); break; } catch(e){}
  }
  let clicked = false;
  for (const sel of ['button[type="submit"]','input[type="submit"]','button.t-Button--hot','button']) {
    try { await page.waitForSelector(sel,{timeout:2000}); await page.click(sel); clicked=true; break; } catch(e){}
  }
  if (!clicked) await page.keyboard.press('Enter');
  await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 25000 });
  if (page.url().includes('LOGIN_DESKTOP')) throw new Error('Login mislukt. Controleer gebruikersnaam en wachtwoord.');
  log('INFO', `Ingelogd. URL: ${page.url()}`);
  await wait(2000);
}

async function navigateToInschrijvingen(page) {
  // Stap 1: klik op "Training & stages" in het linkermenu
  log('INFO', 'Stap 1: klik Training & stages in menu...');
  
  const trainingLink = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a[href]'));
    for (const a of links) {
      const text = (a.innerText || a.textContent || '').trim().toLowerCase();
      const href = a.href || '';
      if (text.includes('training') || href.includes('f?p=111:2:') || href.includes('f?p=111:1:')) {
        return a.href;
      }
    }
    return null;
  });

  if (!trainingLink) throw new Error('Link naar Training & Stages niet gevonden in menu.');
  
  log('INFO', `Training & Stages link: ${trainingLink}`);
  await page.goto(trainingLink, { waitUntil: 'networkidle2', timeout: 30000 });
  await wait(2500);
  log('INFO', `Na Training & Stages: ${page.url()}`);

  // Stap 2: klik op de "Inschrijvingen" kaart (Planning sectie)
  log('INFO', 'Stap 2: klik op Inschrijvingen kaart...');

  const clicked = await page.evaluate(() => {
    // Zoek alle klikbare elementen met tekst "Inschrijvingen"
    const allElements = Array.from(document.querySelectorAll('a, button, div[onclick], span[onclick]'));
    for (const el of allElements) {
      const text = (el.innerText || el.textContent || '').trim();
      if (text === 'Inschrijvingen' || text.toLowerCase() === 'inschrijvingen') {
        el.click();
        return true;
      }
    }
    return false;
  });

  if (!clicked) {
    // Fallback: zoek link die p=111:44 bevat
    log('WARN', 'Inschrijvingen kaart niet gevonden via tekst, zoek via href...');
    const inschLink = await page.evaluate(() => {
      for (const a of document.querySelectorAll('a[href]')) {
        if (a.href.includes('p=111:44') || a.href.includes(':44:')) return a.href;
      }
      return null;
    });
    if (inschLink) {
      log('INFO', `Inschrijvingen href: ${inschLink}`);
      await page.goto(inschLink, { waitUntil: 'networkidle2', timeout: 30000 });
    } else {
      throw new Error('Knop "Inschrijvingen" niet gevonden op de Training & Stages pagina.');
    }
  } else {
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => wait(3000));
  }

  await wait(2500);
  log('INFO', `Na Inschrijvingen klik: ${page.url()}`);
}

async function extractAllTabs(page) {
  let all = [];

  // Lees actieve tab
  const b1 = await extractTable(page);
  log('INFO', `Actieve tab: ${b1.length} rijen`);
  all = all.concat(b1);

  // Zoek inactieve tabs (Lessen / Stages)
  const inactiveTabs = await page.$$([
    '.t-TabsRegion-items li:not(.is-active) a',
    '.t-Tabs-item:not(.is-active) a',
    '[role="tab"]:not([aria-selected="true"])',
    'li.t-NavTabs-item:not(.is-active) a',
  ].join(', '));

  log('INFO', `Extra tabs: ${inactiveTabs.length}`);

  for (const tab of inactiveTabs) {
    try {
      const txt = await page.evaluate(el => (el.innerText||el.textContent||'').trim(), tab);
      log('INFO', `Tab klikken: "${txt}"`);
      await tab.click();
      await wait(2500);
      const batch = await extractTable(page);
      log('INFO', `Tab "${txt}": ${batch.length} rijen`);
      all = all.concat(batch);
    } catch(e) { log('WARN', `Tab fout: ${e.message}`); }
  }

  // Dedup
  const seen = new Set();
  return all.filter(r => { const k=JSON.stringify(r); if(seen.has(k)) return false; seen.add(k); return true; });
}

async function extractTable(page) {
  return page.evaluate(() => {
    const rows = [];
    document.querySelectorAll('table').forEach(table => {
      const headers = [];
      table.querySelectorAll('thead th, thead td').forEach(h => { const t=h.innerText.trim(); if(t) headers.push(t); });
      if (headers.length === 0) {
        const fr = table.querySelector('tr');
        if (fr) fr.querySelectorAll('th,td').forEach(c => { const t=c.innerText.trim(); if(t) headers.push(t); });
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

async function scrapeElit(username, password) {
  log('INFO', `Scrape starten voor: ${username}`);
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    await doLogin(page, username, password);
    await navigateToInschrijvingen(page);

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

async function debugScrape(username, password) {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    await doLogin(page, username, password);
    const screenshotLogin = await page.screenshot({ encoding: 'base64' });
    const urlLogin = page.url();
    const allLinks = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a[href]')).map(a => ({
        text: (a.innerText||a.textContent||'').trim(), href: a.href
      })).filter(l=>l.text||l.href).slice(0,50)
    );

    let navSuccess = false, screenshotNav = null, urlNav = null, tablesNav = [], bodyNav = '', errorMsg = '';
    try {
      await navigateToInschrijvingen(page);
      navSuccess = true;
      screenshotNav = await page.screenshot({ encoding: 'base64' });
      urlNav = page.url();
      bodyNav = await page.evaluate(() => document.body.innerText.slice(0, 800));
      tablesNav = await page.evaluate(() =>
        Array.from(document.querySelectorAll('table')).map(t => ({
          rows: t.querySelectorAll('tr').length,
          headers: Array.from(t.querySelectorAll('th')).map(th=>th.innerText.trim()),
        }))
      );
    } catch(e) {
      errorMsg = e.message;
      screenshotNav = await page.screenshot({ encoding: 'base64' });
      urlNav = page.url();
    }

    await browser.close();
    return { success: true, url_login: urlLogin, screenshot_login: screenshotLogin, all_links: allLinks,
             nav_success: navSuccess, nav_error: errorMsg, url_nav: urlNav, screenshot_nav: screenshotNav,
             body_nav: bodyNav, tables_nav: tablesNav };
  } catch(err) {
    try { await browser.close(); } catch(e) {}
    throw err;
  }
}

// HTTP Server
const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({status:'ok',version:'5.0'})); return;
  }
  if (req.method !== 'POST') { res.writeHead(404); res.end(JSON.stringify({error:'Not found'})); return; }

  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', async () => {
    let payload;
    try { payload = JSON.parse(body); } catch(e) { res.writeHead(400); res.end(JSON.stringify({error:'Ongeldige JSON.'})); return; }

    if (SECRET && payload.secret !== SECRET) { res.writeHead(403); res.end(JSON.stringify({error:'Toegang geweigerd.'})); return; }
    const { username, password, force_refresh } = payload;
    if (!username || !password) { res.writeHead(400); res.end(JSON.stringify({error:'username en password verplicht.'})); return; }

    if (req.url === '/debug') {
      try {
        const r = await debugScrape(username, password);
        res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify(r));
      } catch(err) { res.writeHead(500); res.end(JSON.stringify({error:err.message})); }
      return;
    }

    if (req.url === '/scrape') {
      if (!force_refresh && cache && (Date.now()-cacheTime < CACHE_TTL)) {
        res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({...cache,from_cache:true})); return;
      }
      try {
        const r = await scrapeElit(username, password);
        cache=r; cacheTime=Date.now();
        res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({...r,from_cache:false}));
      } catch(err) { res.writeHead(500); res.end(JSON.stringify({error:err.message,success:false})); }
      return;
    }

    res.writeHead(404); res.end(JSON.stringify({error:'Endpoint niet gevonden.'}));
  });
});

server.listen(PORT, '0.0.0.0', () => {
  log('INFO', `Elit Scraper v5 actief op poort ${PORT}`);
  if (!SECRET) log('WARN', 'Geen SECRET!');
});
process.on('unhandledRejection', r => log('ERROR', String(r)));
