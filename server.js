/**
 * Elit Scraper Service – v8
 * Gebruikt exacte APEX selector-namen uit debug resultaat.
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
      if ((a.innerText||'').trim().toLowerCase().includes('training')) return a.href;
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

// Haal opties op uit een select (filter lege/selecteer opties)
async function getOptions(page, selectId) {
  return page.evaluate((id) => {
    const el = document.getElementById(id);
    if (!el) return [];
    return Array.from(el.options)
      .filter(o => o.value && o.value !== '' && !o.text.includes('Selecteer'))
      .map(o => ({ value: o.value, text: o.text.trim() }));
  }, selectId);
}

// Selecteer optie en wacht op APEX refresh
async function selectAndWait(page, selectId, value) {
  await page.evaluate((id, val) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.value = val;
    // Trigger APEX change event
    el.dispatchEvent(new Event('change', { bubbles: true }));
    // Ook jQuery trigger voor APEX
    if (window.apex && apex.item) {
      try { apex.item(id).setValue(val, null, true); } catch(e) {}
    }
  }, selectId, value);
  await wait(2500); // wacht op APEX dynamic action
}

// Extraheer tabelrijen
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

    // ══════════════════════════════════════════════════
    // TAB 1: LESSEN
    // Selector: P44_LES_SCHEMA_ID_LES (lesaanbod)
    // ══════════════════════════════════════════════════
    log('INFO', '=== LESSEN ===');
    const lesOptions = await getOptions(page, 'P44_LES_SCHEMA_ID_LES');
    log('INFO', `Lesaanbod opties: ${lesOptions.length} → ${lesOptions.map(o=>o.text).join(', ')}`);

    for (const opt of lesOptions) {
      log('INFO', `Lesaanbod selecteren: "${opt.text}"`);
      await selectAndWait(page, 'P44_LES_SCHEMA_ID_LES', opt.value);

      // Haal alle doelgroepen op voor dit lesaanbod
      const doelgroepOptions = await getOptions(page, 'P44_LES_SCHEMA_FORMULE_ID_LES');
      log('INFO', `  Doelgroepen: ${doelgroepOptions.length}`);

      if (doelgroepOptions.length === 0) {
        // Geen subfilter, haal direct de tabel op
        const rows = await extractTable(page);
        rows.forEach(r => { r['__type']='les'; r['__lesaanbod']=opt.text; });
        log('INFO', `  → ${rows.length} rijen`);
        allData.push(...rows);
      } else {
        // Loop door doelgroepen
        for (const dg of doelgroepOptions) {
          await selectAndWait(page, 'P44_LES_SCHEMA_FORMULE_ID_LES', dg.value);
          const rows = await extractTable(page);
          rows.forEach(r => { r['__type']='les'; r['__lesaanbod']=opt.text; });
          log('INFO', `  Doelgroep "${dg.text}": ${rows.length} rijen`);
          allData.push(...rows);
        }
      }
    }

    if (lesOptions.length === 0) {
      // Geen dropdown, pak gewoon de huidige data
      const rows = await extractTable(page);
      rows.forEach(r => { r['__type']='les'; });
      allData.push(...rows);
    }

    // ══════════════════════════════════════════════════
    // TAB 2: STAGES
    // Klik "Stages" tab, dan selector P44_LES_SCHEMA_ID_STAGE
    // ══════════════════════════════════════════════════
    log('INFO', '=== STAGES ===');

    // Klik Stages tab via href
    const stagesHref = await page.evaluate(() => {
      for (const el of document.querySelectorAll('a,[role="tab"]')) {
        const t=(el.innerText||el.textContent||'').trim();
        if (t==='Stages') return el.href || null;
      }
      return null;
    });

    if (stagesHref && stagesHref.startsWith('http')) {
      log('INFO', `Stages href: ${stagesHref}`);
      await page.goto(stagesHref, {waitUntil:'networkidle2',timeout:30000});
      await wait(3000);
    } else {
      // Klik via JS
      await page.evaluate(() => {
        for (const el of document.querySelectorAll('a,[role="tab"],li')) {
          if ((el.innerText||el.textContent||'').trim()==='Stages') { el.click(); return; }
        }
      });
      await page.waitForNavigation({waitUntil:'networkidle2',timeout:15000}).catch(()=>wait(3000));
      await wait(2000);
    }

    log('INFO', `Stages pagina: ${page.url()}`);

    // Loop door alle stage-aanboden: P44_LES_SCHEMA_ID_STAGE
    const stageOptions = await getOptions(page, 'P44_LES_SCHEMA_ID_STAGE');
    log('INFO', `Stage-aanbod opties: ${stageOptions.length} → ${stageOptions.map(o=>o.text).join(', ')}`);

    for (const opt of stageOptions) {
      log('INFO', `Stage selecteren: "${opt.text}"`);
      await selectAndWait(page, 'P44_LES_SCHEMA_ID_STAGE', opt.value);

      // Optioneel: loop ook door doelgroepen (P44_LES_SCHEMA_FORMULE_ID_STAGE)
      const dgOptions = await getOptions(page, 'P44_LES_SCHEMA_FORMULE_ID_STAGE');
      log('INFO', `  Doelgroepen: ${dgOptions.length}`);

      if (dgOptions.length === 0) {
        const rows = await extractTable(page);
        rows.forEach(r => { r['__type']='stage'; r['__stageaanbod']=opt.text; });
        log('INFO', `  → ${rows.length} rijen`);
        allData.push(...rows);
      } else {
        for (const dg of dgOptions) {
          await selectAndWait(page, 'P44_LES_SCHEMA_FORMULE_ID_STAGE', dg.value);
          const rows = await extractTable(page);
          rows.forEach(r => { r['__type']='stage'; r['__stageaanbod']=opt.text; });
          log('INFO', `  Doelgroep "${dg.text}": ${rows.length} rijen`);
          allData.push(...rows);
        }
      }
    }

    if (stageOptions.length === 0) {
      const rows = await extractTable(page);
      rows.forEach(r => { r['__type']='stage'; });
      allData.push(...rows);
    }

    // Dedup op lidnummer + aanbod + type
    const seen = new Set();
    const deduped = allData.filter(r => {
      const key = (r['__type']||'') + '|' + (r['__stageaanbod']||r['__lesaanbod']||'') + '|' + (r['Lidnummer']||'') + '|' + (r['Doelgroep']||'');
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });

    log('INFO', `TOTAAL: ${deduped.length} unieke inschrijvingen (${allData.length} voor dedup)`);
    await browser.close();
    return { success:true, registrations:deduped, count:deduped.length };

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
    await goToInschrijvingen(page);
    const sc2 = await page.screenshot({encoding:'base64'});
    const selects_lessen = await page.evaluate(() =>
      Array.from(document.querySelectorAll('select')).map(s => ({
        id:s.id, name:s.name,
        options:Array.from(s.options).map(o=>({v:o.value,t:o.text.trim()})),
      }))
    );
    await page.evaluate(() => {
      for (const el of document.querySelectorAll('a,[role="tab"]')) {
        if ((el.innerText||'').trim()==='Stages') { el.click(); return; }
      }
    });
    await wait(3000);
    const sc3 = await page.screenshot({encoding:'base64'});
    const selects_stages = await page.evaluate(() =>
      Array.from(document.querySelectorAll('select')).map(s => ({
        id:s.id, name:s.name,
        options:Array.from(s.options).map(o=>({v:o.value,t:o.text.trim()})),
      }))
    );
    await browser.close();
    return { success:true, screenshot_lessen:sc2, screenshot_stages:sc3,
             selects_lessen, selects_stages, url:page.url() };
  } catch(err) { try{await browser.close();}catch(e){} throw err; }
}

const server = http.createServer(async (req,res) => {
  if (req.method==='GET'&&req.url==='/health') { res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({status:'ok',version:'8.0'})); return; }
  if (req.method!=='POST') { res.writeHead(404); res.end(JSON.stringify({error:'Not found'})); return; }
  let body='';
  req.on('data',c=>{body+=c;});
  req.on('end',async()=>{
    let p; try{p=JSON.parse(body);}catch(e){res.writeHead(400);res.end(JSON.stringify({error:'Bad JSON'}));return;}
    if(SECRET&&p.secret!==SECRET){res.writeHead(403);res.end(JSON.stringify({error:'Geweigerd.'}));return;}
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
  log('INFO',`Elit Scraper v8 op poort ${PORT}`);
  if(!SECRET) log('WARN','Geen SECRET!');
});
process.on('unhandledRejection',r=>log('ERROR',String(r)));
