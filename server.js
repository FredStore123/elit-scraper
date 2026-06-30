/**
 * Elit Scraper Service – v11
 * Lessen en Stages zijn nu APARTE jobs: /scrape-lessen en /scrape-stages.
 * Korter, betrouwbaarder, makkelijker te debuggen dan één grote job.
 */
'use strict';

const http      = require('http');
const puppeteer = require('puppeteer');

const PORT   = process.env.PORT   || 3099;
const SECRET = process.env.SECRET || '';
const LOGIN_URL = 'https://elit.tennisvlaanderen.be/ords/f?p=100:LOGIN_DESKTOP:0';

const jobs = {};

function log(level, msg) { console.log(`[${new Date().toISOString()}] [${level}] ${msg}`); }
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
function jobId() { return Date.now().toString(36) + Math.random().toString(36).slice(2,6); }

async function launchBrowser() {
  return puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
           '--disable-gpu','--disable-extensions','--no-first-run','--disable-accelerated-2d-canvas'],
  });
}

async function disableCache(page) {
  await page.setCacheEnabled(false);
  await page.setExtraHTTPHeaders({ 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
}

async function doLogin(page, username, password) {
  await page.goto(LOGIN_URL, {waitUntil:'networkidle2',timeout:30000});
  await page.waitForSelector('input',{timeout:10000});
  for (const sel of ['input[name="P100_USERNAME"]','#P100_USERNAME','input[type="text"]']) {
    try{await page.waitForSelector(sel,{timeout:2000});await page.click(sel,{clickCount:3});await page.type(sel,username,{delay:40});break;}catch(e){}
  }
  for (const sel of ['input[name="P100_PASSWORD"]','#P100_PASSWORD','input[type="password"]']) {
    try{await page.waitForSelector(sel,{timeout:2000});await page.click(sel,{clickCount:3});await page.type(sel,password,{delay:40});break;}catch(e){}
  }
  let clicked=false;
  for (const sel of ['button[type="submit"]','input[type="submit"]','button.t-Button--hot','button']) {
    try{await page.waitForSelector(sel,{timeout:2000});await page.click(sel);clicked=true;break;}catch(e){}
  }
  if(!clicked) await page.keyboard.press('Enter');
  await page.waitForNavigation({waitUntil:'networkidle2',timeout:25000});
  if(page.url().includes('LOGIN_DESKTOP')) throw new Error('Login mislukt. Controleer gebruikersnaam/wachtwoord.');
  log('INFO','Ingelogd!');
  await wait(2000);
}

async function goToInschrijvingen(page) {
  const link = await page.evaluate(()=>{
    for(const a of document.querySelectorAll('a[href]'))
      if((a.innerText||'').trim().toLowerCase().includes('training')) return a.href;
    return null;
  });
  if(!link) throw new Error('Training & Stages link niet gevonden in menu.');
  await page.goto(link,{waitUntil:'networkidle2',timeout:30000});
  await wait(2000);
  const ok = await page.evaluate(()=>{
    for(const el of document.querySelectorAll('a,button'))
      if((el.innerText||'').trim()==='Inschrijvingen'){el.click();return true;}
    return false;
  });
  if(ok) await page.waitForNavigation({waitUntil:'networkidle2',timeout:20000}).catch(()=>wait(3000));
  await wait(3000);
  log('INFO',`Inschrijvingen pagina: ${page.url()}`);
}

async function goToStagesTab(page) {
  const href = await page.evaluate(()=>{
    for(const el of document.querySelectorAll('a,[role="tab"]')){
      if((el.innerText||el.textContent||'').trim()==='Stages') return el.href||null;
    }
    return null;
  });
  if(href && href.startsWith('http')){
    await page.goto(href,{waitUntil:'networkidle2',timeout:30000});
  } else {
    await page.evaluate(()=>{
      for(const el of document.querySelectorAll('a,[role="tab"],li'))
        if((el.innerText||el.textContent||'').trim()==='Stages'){el.click();return;}
    });
    await page.waitForNavigation({waitUntil:'networkidle2',timeout:15000}).catch(()=>wait(3000));
  }
  await wait(2500);
  log('INFO',`Stages tab: ${page.url()}`);
}

async function getOptions(page, id) {
  return page.evaluate(id=>{
    const el=document.getElementById(id);
    if(!el) return [];
    return Array.from(el.options)
      .filter(o=>o.value&&o.value!==''&&!o.text.includes('Selecteer')&&o.text.trim()!=='-')
      .map(o=>({value:o.value,text:o.text.trim()}));
  }, id);
}

async function selectAndWait(page, id, value) {
  const selector = '#' + id;
  try {
    await page.select(selector, value);
  } catch (e) {
    log('WARN', `page.select() mislukt voor ${id}: ${e.message}`);
    await page.evaluate((id,val) => {
      const el = document.getElementById(id);
      if (el) { el.value = val; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); }
    }, id, value);
  }
  await page.evaluate((id,val) => {
    try { if (window.apex && apex.item) apex.item(id).setValue(val); } catch(e) {}
  }, id, value).catch(()=>{});
  await page.waitForNetworkIdle({ idleTime: 1000, timeout: 10000 }).catch(() => {});
  await wait(1500);
}

async function extractTable(page) {
  return page.evaluate(()=>{
    const rows=[];
    document.querySelectorAll('table').forEach(table=>{
      const headers=[];
      table.querySelectorAll('thead th,thead td').forEach(h=>{const t=h.innerText.trim();if(t)headers.push(t);});
      if(headers.length<2) return;
      table.querySelectorAll('tbody tr').forEach(tr=>{
        const cells=tr.querySelectorAll('td');
        if(cells.length<2) return;
        const obj={};
        cells.forEach((td,i)=>{obj[headers[i]||'col_'+i]=td.innerText.trim();});
        if(Object.values(obj).filter(v=>v).length>=2) rows.push(obj);
      });
    });
    return rows;
  });
}

function dedupe(rows) {
  const seen = new Set();
  return rows.filter(r => {
    const k = (r['__type']||'')+'|'+(r['__stageaanbod']||r['__lesaanbod']||'')+'|'+(r['Lidnummer']||'')+'|'+(r['Doelgroep']||'');
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
}

// ── LESSEN scrape (apart, korter) ──────────────────────
async function runScrapeLessen(username, password, jobObj) {
  const browser = await launchBrowser();
  const allData = [];
  try {
    const page = await browser.newPage();
    await disableCache(page);
    await page.setViewport({width:1440,height:900});
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    jobObj.status='login'; jobObj.message='Inloggen op Elit...';
    await doLogin(page, username, password);
    await goToInschrijvingen(page);

    jobObj.status='lessen'; jobObj.message='Lesaanbod ophalen...';
    const lesOptions = await getOptions(page,'P44_LES_SCHEMA_ID_LES');
    log('INFO',`Lessen: ${lesOptions.length} opties: ${lesOptions.map(o=>o.text).join(', ')}`);

    if (lesOptions.length === 0) {
      const rows = await extractTable(page);
      rows.forEach(r=>{r['__type']='les';});
      allData.push(...rows);
    }

    for(let i=0;i<lesOptions.length;i++){
      const opt=lesOptions[i];
      jobObj.message=`Lessen: ${opt.text} (${i+1}/${lesOptions.length})`;
      log('INFO',`Les selecteren: "${opt.text}"`);
      await selectAndWait(page,'P44_LES_SCHEMA_ID_LES',opt.value);
      const rows=await extractTable(page);
      rows.forEach(r=>{r['__type']='les';r['__lesaanbod']=opt.text;});
      log('INFO',`  → ${rows.length} rijen`);
      allData.push(...rows);
    }

    const deduped = dedupe(allData);
    log('INFO',`Lessen totaal: ${deduped.length} unieke rijen`);
    await browser.close();

    const result = { success:true, registrations:deduped, count:deduped.length, type:'lessen' };
    jobObj.status='done'; jobObj.message=`Klaar: ${deduped.length} lessen-inschrijvingen.`;
    jobObj.result=result;

  } catch(err) {
    log('ERROR', 'LESSEN: ' + err.message);
    try{await browser.close();}catch(e){}
    jobObj.status='error'; jobObj.message=err.message; jobObj.result={success:false,error:err.message,type:'lessen'};
  }
}

// ── STAGES scrape (apart, korter) ──────────────────────
async function runScrapeStages(username, password, jobObj) {
  const browser = await launchBrowser();
  const allData = [];
  try {
    const page = await browser.newPage();
    await disableCache(page);
    await page.setViewport({width:1440,height:900});
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    jobObj.status='login'; jobObj.message='Inloggen op Elit...';
    await doLogin(page, username, password);
    await goToInschrijvingen(page);

    jobObj.status='navigeren'; jobObj.message='Navigeren naar Stages tab...';
    await goToStagesTab(page);

    jobObj.status='stages'; jobObj.message='Stage-aanbod ophalen...';
    const stageOptions = await getOptions(page,'P44_LES_SCHEMA_ID_STAGE');
    log('INFO',`Stages: ${stageOptions.length} opties: ${stageOptions.map(o=>o.text).join(', ')}`);

    if (stageOptions.length === 0) {
      const rows = await extractTable(page);
      rows.forEach(r=>{r['__type']='stage';});
      allData.push(...rows);
    }

    for(let i=0;i<stageOptions.length;i++){
      const opt=stageOptions[i];
      jobObj.message=`Stages: ${opt.text} (${i+1}/${stageOptions.length})`;
      log('INFO',`Stage selecteren: "${opt.text}"`);
      await selectAndWait(page,'P44_LES_SCHEMA_ID_STAGE',opt.value);
      const rows=await extractTable(page);
      rows.forEach(r=>{r['__type']='stage';r['__stageaanbod']=opt.text;});
      log('INFO',`  → ${rows.length} rijen`);
      allData.push(...rows);
    }

    const deduped = dedupe(allData);
    log('INFO',`Stages totaal: ${deduped.length} unieke rijen`);
    await browser.close();

    const result = { success:true, registrations:deduped, count:deduped.length, type:'stages' };
    jobObj.status='done'; jobObj.message=`Klaar: ${deduped.length} stage-inschrijvingen.`;
    jobObj.result=result;

  } catch(err) {
    log('ERROR', 'STAGES: ' + err.message);
    try{await browser.close();}catch(e){}
    jobObj.status='error'; jobObj.message=err.message; jobObj.result={success:false,error:err.message,type:'stages'};
  }
}

async function debugScrape(username, password) {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await disableCache(page);
    await page.setViewport({width:1440,height:900});
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await doLogin(page, username, password);
    await goToInschrijvingen(page);
    const sc2 = await page.screenshot({encoding:'base64'});
    const selects_lessen = await page.evaluate(() =>
      Array.from(document.querySelectorAll('select')).map(s => ({id:s.id,name:s.name,options:Array.from(s.options).map(o=>({v:o.value,t:o.text.trim()}))}))
    );
    await goToStagesTab(page);
    const sc3 = await page.screenshot({encoding:'base64'});
    const selects_stages = await page.evaluate(() =>
      Array.from(document.querySelectorAll('select')).map(s => ({id:s.id,name:s.name,options:Array.from(s.options).map(o=>({v:o.value,t:o.text.trim()}))}))
    );
    await browser.close();
    return { success:true, screenshot_lessen:sc2, screenshot_stages:sc3, selects_lessen, selects_stages };
  } catch(err) { try{await browser.close();}catch(e){} throw err; }
}

// ── HTTP Server ─────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  if (req.method==='GET'&&req.url==='/health') {
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({status:'ok',version:'11.0'})); return;
  }

  if (req.method==='GET'&&req.url.startsWith('/status/')) {
    const jid = req.url.split('/')[2];
    const job = jobs[jid];
    if (!job) { res.writeHead(404); res.end(JSON.stringify({error:'Job niet gevonden.'})); return; }
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({status:job.status,message:job.message,done:job.status==='done'||job.status==='error'}));
    return;
  }

  if (req.method==='GET'&&req.url.startsWith('/result/')) {
    const jid = req.url.split('/')[2];
    const job = jobs[jid];
    if (!job) { res.writeHead(404); res.end(JSON.stringify({error:'Job niet gevonden.'})); return; }
    if (job.status!=='done'&&job.status!=='error') { res.writeHead(202); res.end(JSON.stringify({status:job.status,message:job.message})); return; }
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify(job.result||{success:false,error:job.message}));
    return;
  }

  if (req.method!=='POST') { res.writeHead(404); res.end(JSON.stringify({error:'Not found'})); return; }

  let body='';
  req.on('data',c=>{body+=c;});
  req.on('end',async()=>{
    let p; try{p=JSON.parse(body);}catch(e){res.writeHead(400);res.end(JSON.stringify({error:'Bad JSON'}));return;}
    if(SECRET&&p.secret!==SECRET){res.writeHead(403);res.end(JSON.stringify({error:'Geweigerd.'}));return;}
    const{username,password}=p;
    if(!username||!password){res.writeHead(400);res.end(JSON.stringify({error:'Credentials verplicht.'}));return;}

    if(req.url==='/debug'){
      try{const r=await debugScrape(username,password);res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(r));}
      catch(err){res.writeHead(500);res.end(JSON.stringify({error:err.message}));}
      return;
    }

    if(req.url==='/scrape-lessen'){
      const jid=jobId();
      jobs[jid]={status:'starting',message:'Lessen-job gestart...',result:null};
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({job_id:jid,status:'starting'}));
      runScrapeLessen(username,password,jobs[jid]).catch(err=>{jobs[jid].status='error';jobs[jid].message=err.message;});
      return;
    }

    if(req.url==='/scrape-stages'){
      const jid=jobId();
      jobs[jid]={status:'starting',message:'Stages-job gestart...',result:null};
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({job_id:jid,status:'starting'}));
      runScrapeStages(username,password,jobs[jid]).catch(err=>{jobs[jid].status='error';jobs[jid].message=err.message;});
      return;
    }

    res.writeHead(404); res.end(JSON.stringify({error:'Endpoint niet gevonden. Gebruik /scrape-lessen of /scrape-stages.'}));
  });
});

server.listen(PORT,'0.0.0.0',()=>{
  log('INFO',`Elit Scraper v11 (Lessen/Stages gesplitst) op poort ${PORT}`);
  if(!SECRET) log('WARN','Geen SECRET ingesteld! Stel de SECRET env var in op Railway.');
});
process.on('unhandledRejection',r=>log('ERROR',String(r)));
