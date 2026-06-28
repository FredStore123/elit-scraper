/**
 * Elit Scraper Service – v7
 * Robuuste dropdown-detectie voor zowel Lessen als Stages.
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
  await page.goto(LOGIN_URL, { waitUntil:'networkidle2', timeout:30000 });
  await page.waitForSelector('input', { timeout:10000 });
  for (const sel of ['input[name="P100_USERNAME"]','#P100_USERNAME','input[type="text"]']) {
    try { await page.waitForSelector(sel,{timeout:2000}); await page.click(sel,{clickCount:3}); await page.type(sel,username,{delay:40}); break; } catch(e){}
  }
  for (const sel of ['input[name="P100_PASSWORD"]','#P100_PASSWORD','input[type="password"]']) {
    try { await page.waitForSelector(sel,{timeout:2000}); await page.click(sel,{clickCount:3}); await page.type(sel,password,{delay:40}); break; } catch(e){}
  }
  let clicked=false;
  for (const sel of ['button[type="submit"]','input[type="submit"]','button.t-Button--hot','button']) {
    try { await page.waitForSelector(sel,{timeout:2000}); await page.click(sel); clicked=true; break; } catch(e){}
  }
  if (!clicked) await page.keyboard.press('Enter');
  await page.waitForNavigation({waitUntil:'networkidle2',timeout:25000});
  if (page.url().includes('LOGIN_DESKTOP')) throw new Error('Login mislukt.');
  log('INFO','Ingelogd!');
  await wait(2000);
}

async function goToInschrijvingen(page) {
  const trainingLink = await page.evaluate(() => {
    for (const a of document.querySelectorAll('a[href]')) {
      const t=(a.innerText||'').trim().toLowerCase();
      if (t.includes('training')) return a.href;
    }
    return null;
  });
  if (!trainingLink) throw new Error('Training & Stages link niet gevonden.');
  await page.goto(trainingLink, {waitUntil:'networkidle2',timeout:30000});
  await wait(2000);
  const clicked = await page.evaluate(() => {
    for (const el of document.querySelectorAll('a,button')) {
      if ((el.innerText||'').trim()==='Inschrijvingen') { el.click(); return true; }
    }
    return false;
  });
  if (clicked) await page.waitForNavigation({waitUntil:'networkidle2',timeout:20000}).catch(()=>wait(3000));
  await wait(3000);
  log('INFO',`Inschrijvingen: ${page.url()}`);
}

// Vind de EERSTE select met meerdere opties (het aanbod-dropdown)
async function findMainSelect(page) {
  const info = await page.evaluate(() => {
    const selects = Array.from(document.querySelectorAll('select'));
    for (const sel of selects) {
      const opts = Array.from(sel.options).filter(o => o.value && o.value !== '' && o.text.trim() !== '- Selecteer -');
      if (opts.length > 0) {
        return {
          id:    sel.id,
          name:  sel.name,
          selector: sel.id ? `#${sel.id}` : `select[name="${sel.name}"]`,
          options: opts.map(o => ({ value: o.value, text: o.text.trim() })),
        };
      }
    }
    return null;
  });
  return info;
}

async function extractTable(page, label, type) {
  const rows = await page.evaluate(() => {
    const results = [];
    document.querySelectorAll('table').forEach(table => {
      const headers = [];
      table.querySelectorAll('thead th, thead td').forEach(h => { const t=h.innerText.trim(); if(t) headers.push(t); });
      if (headers.length < 2) return;
      table.querySelectorAll('tbody tr').forEach(tr => {
        const cells = tr.querySelectorAll('td');
        if (cells.length < 2) return;
        const obj = {};
        cells.forEach((td,i) => { obj[headers[i]||'col_'+i] = td.innerText.trim(); });
        if (Object.values(obj).filter(v=>v).length >= 2) results.push(obj);
      });
    });
    return results;
  });
  rows.forEach(r => { r['__label'] = label; r['__type'] = type; });
  return rows;
}

async function scrapeTab(page, type) {
  const all = [];

  const mainSel = await findMainSelect(page);
  if (!mainSel) {
    log('WARN', `Geen dropdown gevonden voor tab: ${type}`);
    const rows = await extractTable(page, '', type);
    return rows;
  }

  log('INFO', `Dropdown gevonden: ${mainSel.selector} met ${mainSel.options.length} opties`);
  mainSel.options.forEach(o => log('INFO', `  - ${o.text} (${o.value})`));

  for (const opt of mainSel.options) {
    log('INFO', `Selecteer: ${opt.text}`);
    await page.select(mainSel.selector, opt.value);
    await wait(2500); // wacht op APEX dynamische refresh

    const rows = await extractTable(page, opt.text, type);
    log('INFO', `  → ${rows.length} rijen`);
    all.push(...rows);
  }

  return all;
}

async function scrapeElit(username, password) {
  log('INFO', `Start scrape: ${username}`);
  const browser = await launchBrowser();
  const allData = [];

  try {
    const page = await browser.newPage();
    await page.setViewport({width:1440,height:900});
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    await doLogin(page, username, password);
    await goToInschrijvingen(page);

    // ── Lessen (actieve tab) ───────────────────────────
    log('INFO', '=== TAB: LESSEN ===');
    const lessen = await scrapeTab(page, 'les');
    log('INFO', `Lessen totaal: ${lessen.length}`);
    allData.push(...lessen);

    // ── Stages tab klikken ─────────────────────────────
    log('INFO', '=== TAB: STAGES ===');

    // Probeer via tekst "Stages" te klikken
    const stagesTabClicked = await page.evaluate(() => {
      // Zoek link/button met exact "Stages"
      const candidates = Array.from(document.querySelectorAll('a, button, [role="tab"], li'));
      for (const el of candidates) {
        const t = (el.innerText||el.textContent||'').trim();
        if (t === 'Stages') {
          // Als het een <li> is, zoek de <a> erin
          const a = el.tagName === 'A' ? el : el.querySelector('a');
          if (a) { a.click(); return 'link:'+a.href; }
          el.click(); return 'el:'+el.tagName;
        }
      }
      return null;
    });

    log('INFO', `Stages tab click: ${stagesTabClicked}`);

    if (stagesTabClicked) {
      // Als het een href was, navigeer er direct naartoe
      if (stagesTabClicked.startsWith('link:http')) {
        const href = stagesTabClicked.replace('link:','');
        await page.goto(href, {waitUntil:'networkidle2',timeout:30000});
      } else {
        await page.waitForNavigation({waitUntil:'networkidle2',timeout:15000}).catch(()=>wait(3000));
      }
      await wait(3000);
      log('INFO', `Na Stages tab: ${page.url()}`);

      const stages = await scrapeTab(page, 'stage');
      log('INFO', `Stages totaal: ${stages.length}`);
      allData.push(...stages);
    } else {
      log('WARN', 'Stages tab niet gevonden!');
    }

    log('INFO', `TOTAAL: ${allData.length} inschrijvingen`);
    await browser.close();

    return { success:true, registrations:allData, count:allData.length };

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
    await page.setViewport({width:1440,height:900});
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await doLogin(page, username, password);
    const sc1 = await page.screenshot({encoding:'base64'});
    await goToInschrijvingen(page);
    const sc2 = await page.screenshot({encoding:'base64'});

    // Analyseer selects op de pagina
    const selectInfo = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('select')).map(s => ({
        id: s.id, name: s.name,
        options: Array.from(s.options).map(o => ({v:o.value,t:o.text.trim()})),
      }));
    });

    // Klik stages tab
    await page.evaluate(() => {
      for (const el of document.querySelectorAll('a,button,[role="tab"]')) {
        if ((el.innerText||'').trim()==='Stages') { el.click(); return; }
      }
    });
    await wait(3000);
    const sc3 = await page.screenshot({encoding:'base64'});
    const selectInfoStages = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('select')).map(s => ({
        id:s.id, name:s.name,
        options:Array.from(s.options).map(o=>({v:o.value,t:o.text.trim()})),
      }));
    });

    await browser.close();
    return { success:true, screenshot_login:sc1, screenshot_lessen:sc2, screenshot_stages:sc3,
             selects_lessen:selectInfo, selects_stages:selectInfoStages, url:page.url() };
  } catch(err) {
    try { await browser.close(); } catch(e) {}
    throw err;
  }
}

const server = http.createServer(async (req,res) => {
  if (req.method==='GET'&&req.url==='/health') { res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({status:'ok',version:'7.0'})); return; }
  if (req.method!=='POST') { res.writeHead(404); res.end(JSON.stringify({error:'Not found'})); return; }
  let body='';
  req.on('data',chunk=>{body+=chunk;});
  req.on('end',async()=>{
    let p; try{p=JSON.parse(body);}catch(e){res.writeHead(400);res.end(JSON.stringify({error:'Bad JSON'}));return;}
    if(SECRET&&p.secret!==SECRET){res.writeHead(403);res.end(JSON.stringify({error:'Toegang geweigerd.'}));return;}
    const{username,password,force_refresh}=p;
    if(!username||!password){res.writeHead(400);res.end(JSON.stringify({error:'Credentials verplicht.'}));return;}

    if(req.url==='/debug'){
      try{const r=await debugScrape(username,password);res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(r));}
      catch(err){res.writeHead(500);res.end(JSON.stringify({error:err.message}));}
      return;
    }
    if(req.url==='/scrape'){
      if(!force_refresh&&cache&&(Date.now()-cacheTime<CACHE_TTL)){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({...cache,from_cache:true}));return;}
      try{
        const r=await scrapeElit(username,password);
        cache=r;cacheTime=Date.now();
        res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({...r,from_cache:false}));
      }catch(err){res.writeHead(500);res.end(JSON.stringify({error:err.message,success:false}));}
      return;
    }
    res.writeHead(404);res.end(JSON.stringify({error:'Niet gevonden.'}));
  });
});

server.listen(PORT,'0.0.0.0',()=>{
  log('INFO',`Elit Scraper v7 op poort ${PORT}`);
  if(!SECRET) log('WARN','Geen SECRET!');
});
process.on('unhandledRejection',r=>log('ERROR',String(r)));
