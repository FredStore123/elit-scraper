/**
 * Elit Scraper Service – v6
 * Haalt ALLE lessen én ALLE stages op door elke dropdown-optie te doorlopen.
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
  await page.waitForNavigation({ waitUntil:'networkidle2', timeout:25000 });
  if (page.url().includes('LOGIN_DESKTOP')) throw new Error('Login mislukt.');
  log('INFO', 'Ingelogd!');
  await wait(2000);
}

async function navigateToInschrijvingen(page) {
  // Klik Training & stages in menu
  const trainingLink = await page.evaluate(() => {
    for (const a of document.querySelectorAll('a[href]')) {
      const t = (a.innerText||'').trim().toLowerCase();
      if (t.includes('training') || a.href.includes('f?p=111:2:') || a.href.includes('f?p=111:1:')) return a.href;
    }
    return null;
  });
  if (!trainingLink) throw new Error('Training & Stages link niet gevonden.');
  await page.goto(trainingLink, { waitUntil:'networkidle2', timeout:30000 });
  await wait(2000);

  // Klik Inschrijvingen kaart
  const clicked = await page.evaluate(() => {
    for (const el of document.querySelectorAll('a,button')) {
      if ((el.innerText||'').trim() === 'Inschrijvingen') { el.click(); return true; }
    }
    return false;
  });
  if (clicked) {
    await page.waitForNavigation({ waitUntil:'networkidle2', timeout:20000 }).catch(() => wait(3000));
  }
  await wait(2500);
  log('INFO', `Inschrijvingen pagina: ${page.url()}`);
}

// Haal alle opties op uit een select-dropdown
async function getSelectOptions(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return [];
    return Array.from(el.options)
      .filter(o => o.value && o.value !== '')
      .map(o => ({ value: o.value, text: o.text.trim() }));
  }, selector);
}

// Selecteer een optie in een dropdown en wacht op refresh
async function selectOption(page, selector, value) {
  await page.select(selector, value);
  await wait(2000); // wacht op APEX refresh
}

// Extraheer tabeldata van huidige view
async function extractTable(page) {
  return page.evaluate(() => {
    const rows = [];
    document.querySelectorAll('table').forEach(table => {
      const headers = [];
      table.querySelectorAll('thead th, thead td').forEach(h => { const t=h.innerText.trim(); if(t) headers.push(t); });
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

// Haal de naam van de geselecteerde optie op
async function getSelectedLabel(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return '';
    const opt = el.options[el.selectedIndex];
    return opt ? opt.text.trim() : '';
  }, selector);
}

async function scrapeElit(username, password) {
  log('INFO', `Scrape starten voor: ${username}`);
  const browser = await launchBrowser();
  const allRegistrations = [];

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    await doLogin(page, username, password);
    await navigateToInschrijvingen(page);

    // ── TAB 1: Lessen ──────────────────────────────────
    log('INFO', 'Verwerken: Lessen tab');

    // Zoek de eerste dropdown (Lesaanbod)
    const lessenSelectors = [
      'select[name*="P44_"]',
      'select[id*="P44_"]',
      'select',
    ];

    let lesaanbodSel = null;
    for (const sel of lessenSelectors) {
      const opts = await getSelectOptions(page, sel);
      if (opts.length > 0) { lesaanbodSel = sel; break; }
    }

    if (lesaanbodSel) {
      const lesOptions = await getSelectOptions(page, lesaanbodSel);
      log('INFO', `Lesaanbod opties: ${lesOptions.length}`);

      for (const opt of lesOptions) {
        log('INFO', `Lesaanbod: ${opt.text}`);
        await selectOption(page, lesaanbodSel, opt.value);
        const rows = await extractTable(page);
        log('INFO', `  → ${rows.length} lessen-inschrijvingen`);
        // Voeg lesaanbod-naam toe aan elke rij
        rows.forEach(r => { r['__lesaanbod'] = opt.text; r['__type'] = 'les'; });
        allRegistrations.push(...rows);
      }
    } else {
      // Geen dropdown gevonden, haal gewoon de huidige data op
      const rows = await extractTable(page);
      rows.forEach(r => { r['__type'] = 'les'; });
      allRegistrations.push(...rows);
      log('INFO', `Lessen (geen dropdown): ${rows.length} rijen`);
    }

    // ── TAB 2: Stages ──────────────────────────────────
    log('INFO', 'Verwerken: Stages tab');

    // Klik op de Stages tab
    const stagesClicked = await page.evaluate(() => {
      const tabs = Array.from(document.querySelectorAll('a,button,[role="tab"]'));
      for (const el of tabs) {
        const t = (el.innerText||el.textContent||'').trim().toLowerCase();
        if (t === 'stages' || t.includes('stage')) { el.click(); return true; }
      }
      return false;
    });

    if (stagesClicked) {
      await wait(3000);
      log('INFO', `Stages tab geklikt, URL: ${page.url()}`);

      // Zoek stage-aanbod dropdown
      let stageSelOpt = null;
      for (const sel of lessenSelectors) {
        const opts = await getSelectOptions(page, sel);
        if (opts.length > 0) { stageSelOpt = sel; break; }
      }

      if (stageSelOpt) {
        const stageOptions = await getSelectOptions(page, stageSelOpt);
        log('INFO', `Stage-aanbod opties: ${stageOptions.length}`);

        for (const opt of stageOptions) {
          log('INFO', `Stage-aanbod: ${opt.text}`);
          await selectOption(page, stageSelOpt, opt.value);
          const rows = await extractTable(page);
          log('INFO', `  → ${rows.length} stage-inschrijvingen`);
          rows.forEach(r => { r['__stageaanbod'] = opt.text; r['__type'] = 'stage'; });
          allRegistrations.push(...rows);
        }
      } else {
        const rows = await extractTable(page);
        rows.forEach(r => { r['__type'] = 'stage'; });
        allRegistrations.push(...rows);
        log('INFO', `Stages (geen dropdown): ${rows.length} rijen`);
      }
    } else {
      log('WARN', 'Stages tab niet gevonden');
    }

    log('INFO', `Totaal: ${allRegistrations.length} inschrijvingen`);
    await browser.close();

    return {
      success: true,
      registrations: allRegistrations,
      html_fallback: null,
      count: allRegistrations.length,
    };

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
    const screenshotLogin = await page.screenshot({ encoding:'base64' });
    const allLinks = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a[href]')).map(a => ({ text:(a.innerText||'').trim(), href:a.href })).slice(0,50)
    );
    let screenshotNav=null, urlNav=null, tablesNav=[], bodyNav='', navError='';
    try {
      await navigateToInschrijvingen(page);
      screenshotNav = await page.screenshot({ encoding:'base64' });
      urlNav = page.url();
      bodyNav = await page.evaluate(() => document.body.innerText.slice(0,800));
      tablesNav = await page.evaluate(() =>
        Array.from(document.querySelectorAll('table')).map(t => ({
          rows: t.querySelectorAll('tr').length,
          headers: Array.from(t.querySelectorAll('th')).map(th=>th.innerText.trim()),
        }))
      );
    } catch(e) { navError = e.message; screenshotNav = await page.screenshot({encoding:'base64'}); urlNav=page.url(); }
    await browser.close();
    return { success:true, url_login:page.url(), screenshot_login:screenshotLogin, all_links:allLinks,
             nav_success:!navError, nav_error:navError, url_nav:urlNav, screenshot_nav:screenshotNav,
             body_nav:bodyNav, tables_nav:tablesNav };
  } catch(err) {
    try { await browser.close(); } catch(e) {}
    throw err;
  }
}

// HTTP Server
const server = http.createServer(async (req, res) => {
  if (req.method==='GET' && req.url==='/health') {
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({status:'ok',version:'6.0'})); return;
  }
  if (req.method!=='POST') { res.writeHead(404); res.end(JSON.stringify({error:'Not found'})); return; }

  let body='';
  req.on('data', chunk => { body+=chunk; });
  req.on('end', async () => {
    let payload;
    try { payload=JSON.parse(body); } catch(e) { res.writeHead(400); res.end(JSON.stringify({error:'Ongeldige JSON.'})); return; }
    if (SECRET && payload.secret!==SECRET) { res.writeHead(403); res.end(JSON.stringify({error:'Toegang geweigerd.'})); return; }
    const {username,password,force_refresh}=payload;
    if (!username||!password) { res.writeHead(400); res.end(JSON.stringify({error:'username en password verplicht.'})); return; }

    if (req.url==='/debug') {
      try { const r=await debugScrape(username,password); res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify(r)); }
      catch(err) { res.writeHead(500); res.end(JSON.stringify({error:err.message})); }
      return;
    }

    if (req.url==='/scrape') {
      if (!force_refresh && cache && (Date.now()-cacheTime<CACHE_TTL)) {
        res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({...cache,from_cache:true})); return;
      }
      try {
        const r=await scrapeElit(username,password);
        cache=r; cacheTime=Date.now();
        res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({...r,from_cache:false}));
      } catch(err) { res.writeHead(500); res.end(JSON.stringify({error:err.message,success:false})); }
      return;
    }
    res.writeHead(404); res.end(JSON.stringify({error:'Endpoint niet gevonden.'}));
  });
});

server.listen(PORT,'0.0.0.0',()=>{
  log('INFO',`Elit Scraper v6 actief op poort ${PORT}`);
  if(!SECRET) log('WARN','Geen SECRET!');
});
process.on('unhandledRejection',r=>log('ERROR',String(r)));
