/**
 * Elit Scraper Service – v8b
 * Async job systeem: /scrape start de job en geeft direct een job_id terug.
 * /status/:job_id geeft de voortgang.
 * /result/:job_id geeft het resultaat als klaar.
 */
'use strict';

const http      = require('http');
const puppeteer = require('puppeteer');

const PORT   = process.env.PORT   || 3099;
const SECRET = process.env.SECRET || '';
const LOGIN_URL = 'https://elit.tennisvlaanderen.be/ords/f?p=100:LOGIN_DESKTOP:0';

// Cache
let cache = null, cacheTime = 0;
const CACHE_TTL = 15 * 60 * 1000;

// Job tracking
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
  await page.setExtraHTTPHeaders({
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma': 'no-cache',
  });
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
  if(page.url().includes('LOGIN_DESKTOP')) throw new Error('Login mislukt.');
  await wait(2000);
}

async function goToInschrijvingen(page) {
  const link = await page.evaluate(()=>{
    for(const a of document.querySelectorAll('a[href]'))
      if((a.innerText||'').trim().toLowerCase().includes('training')) return a.href;
    return null;
  });
  if(!link) throw new Error('Training link niet gevonden.');
  await page.goto(link,{waitUntil:'networkidle2',timeout:30000});
  await wait(2000);
  const ok = await page.evaluate(()=>{
    for(const el of document.querySelectorAll('a,button'))
      if((el.innerText||'').trim()==='Inschrijvingen'){el.click();return true;}
    return false;
  });
  if(ok) await page.waitForNavigation({waitUntil:'networkidle2',timeout:20000}).catch(()=>wait(3000));
  await wait(3000);
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

  // Gebruik Puppeteer's eigen select() — simuleert een ECHTE browser-interactie
  // (klik + native select + change event), in tegenstelling tot el.value= wat
  // APEX dynamic actions niet altijd detecteren.
  try {
    await page.select(selector, value);
  } catch (e) {
    log('WARN', `page.select() mislukt voor ${id}: ${e.message}`);
    // Fallback: focus + keyboard, simuleert nog explicieter een gebruiker
    await page.focus(selector);
    await page.evaluate((id,val) => {
      const el = document.getElementById(id);
      if (el) {
        el.value = val;
        el.dispatchEvent(new Event('input', {bubbles:true}));
        el.dispatchEvent(new Event('change', {bubbles:true}));
      }
    }, id, value);
  }

  // Probeer ook APEX's eigen item API te triggeren als die beschikbaar is
  await page.evaluate((id,val) => {
    try {
      if (window.apex && apex.item) {
        apex.item(id).setValue(val);
      }
    } catch(e) {}
  }, id, value).catch(() => {});

  // Wacht op APEX AJAX refresh (netwerk + DOM)
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

async function runScrape(username, password, jobObj) {
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

    // ── LESSEN ────────────────────────────────────────
    jobObj.status='lessen'; jobObj.message='Lessen ophalen...';
    const lesOptions = await getOptions(page,'P44_LES_SCHEMA_ID_LES');
    log('INFO',`Lessen: ${lesOptions.length} opties`);

    for(let i=0;i<lesOptions.length;i++){
      const opt=lesOptions[i];
      jobObj.message=`Lessen: ${opt.text} (${i+1}/${lesOptions.length})`;
      log('INFO',`Les selecteren: "${opt.text}" (value=${opt.value})`);

      const tableCountBefore = await page.evaluate(() => document.querySelectorAll('table tbody tr').length);
      await selectAndWait(page,'P44_LES_SCHEMA_ID_LES',opt.value);

      const actualValue = await page.evaluate(id => document.getElementById(id)?.value, 'P44_LES_SCHEMA_ID_LES');
      const tableCountAfter = await page.evaluate(() => document.querySelectorAll('table tbody tr').length);
      log('INFO',`  Select waarde: verwacht=${opt.value} werkelijk=${actualValue} | tabelrijen voor=${tableCountBefore} na=${tableCountAfter}`);

      const rows=await extractTable(page);
      rows.forEach(r=>{r['__type']='les';r['__lesaanbod']=opt.text;});
      log('INFO',`  → ${rows.length} rijen via extractTable`);
      allData.push(...rows);
    }

    if(lesOptions.length===0){
      const rows=await extractTable(page);
      rows.forEach(r=>{r['__type']='les';});
      allData.push(...rows);
    }

    // ── STAGES ────────────────────────────────────────
    jobObj.status='stages'; jobObj.message='Navigeren naar Stages...';

    // Klik Stages tab
    const stagesHref=await page.evaluate(()=>{
      for(const el of document.querySelectorAll('a,[role="tab"]')){
        if((el.innerText||el.textContent||'').trim()==='Stages') return el.href||null;
      }
      return null;
    });

    if(stagesHref&&stagesHref.startsWith('http')){
      await page.goto(stagesHref,{waitUntil:'networkidle2',timeout:30000});
    } else {
      await page.evaluate(()=>{
        for(const el of document.querySelectorAll('a,[role="tab"],li'))
          if((el.innerText||el.textContent||'').trim()==='Stages'){el.click();return;}
      });
      await page.waitForNavigation({waitUntil:'networkidle2',timeout:15000}).catch(()=>wait(3000));
    }
    await wait(2500);

    const stageOptions=await getOptions(page,'P44_LES_SCHEMA_ID_STAGE');
    log('INFO',`Stages: ${stageOptions.length} opties`);

    for(let i=0;i<stageOptions.length;i++){
      const opt=stageOptions[i];
      jobObj.message=`Stages: ${opt.text} (${i+1}/${stageOptions.length})`;
      log('INFO',`Stage: ${opt.text}`);
      await selectAndWait(page,'P44_LES_SCHEMA_ID_STAGE',opt.value);
      const rows=await extractTable(page);
      rows.forEach(r=>{r['__type']='stage';r['__stageaanbod']=opt.text;});
      log('INFO',`  ${rows.length} rijen`);
      allData.push(...rows);
    }

    if(stageOptions.length===0){
      const rows=await extractTable(page);
      rows.forEach(r=>{r['__type']='stage';});
      allData.push(...rows);
    }

    // Dedup
    const seen=new Set();
    const deduped=allData.filter(r=>{
      const k=(r['__type']||'')+'|'+(r['__stageaanbod']||r['__lesaanbod']||'')+'|'+(r['Lidnummer']||'')+'|'+(r['Doelgroep']||'');
      if(seen.has(k)) return false; seen.add(k); return true;
    });

    log('INFO',`Totaal: ${deduped.length} unieke records`);
    await browser.close();

    const result={success:true,registrations:deduped,count:deduped.length};
    cache=result; cacheTime=Date.now();
    jobObj.status='done'; jobObj.message=`Klaar: ${deduped.length} inschrijvingen.`;
    jobObj.result=result;

  } catch(err) {
    log('ERROR',err.message);
    try{await browser.close();}catch(e){}
    jobObj.status='error'; jobObj.message=err.message; jobObj.result={success:false,error:err.message};
  }
}

async function debugScrape(username, password) {
  const browser=await launchBrowser();
  try{
    const page=await browser.newPage();
    await page.setViewport({width:1440,height:900});
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await doLogin(page,username,password);
    await goToInschrijvingen(page);
    const sc2=await page.screenshot({encoding:'base64'});
    const sl=await page.evaluate(()=>Array.from(document.querySelectorAll('select')).map(s=>({id:s.id,name:s.name,options:Array.from(s.options).map(o=>({v:o.value,t:o.text.trim()}))})));
    await page.evaluate(()=>{for(const el of document.querySelectorAll('a,[role="tab"]'))if((el.innerText||'').trim()==='Stages'){el.click();return;}});
    await wait(3000);
    const sc3=await page.screenshot({encoding:'base64'});
    const ss=await page.evaluate(()=>Array.from(document.querySelectorAll('select')).map(s=>({id:s.id,name:s.name,options:Array.from(s.options).map(o=>({v:o.value,t:o.text.trim()}))})));
    await browser.close();
    return{success:true,screenshot_lessen:sc2,screenshot_stages:sc3,selects_lessen:sl,selects_stages:ss};
  }catch(err){try{await browser.close();}catch(e){}throw err;}
}

// HTTP Server
const server=http.createServer(async(req,res)=>{
  if(req.method==='GET'&&req.url==='/health'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({status:'ok',version:'8b'}));return;}

  // Status check: GET /status/jobid
  if(req.method==='GET'&&req.url.startsWith('/status/')){
    const jid=req.url.split('/')[2];
    const job=jobs[jid];
    if(!job){res.writeHead(404);res.end(JSON.stringify({error:'Job niet gevonden.'}));return;}
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({status:job.status,message:job.message,done:job.status==='done'||job.status==='error'}));
    return;
  }

  // Result: GET /result/jobid
  if(req.method==='GET'&&req.url.startsWith('/result/')){
    const jid=req.url.split('/')[2];
    const job=jobs[jid];
    if(!job){res.writeHead(404);res.end(JSON.stringify({error:'Job niet gevonden.'}));return;}
    if(job.status!=='done'&&job.status!=='error'){res.writeHead(202);res.end(JSON.stringify({status:job.status,message:job.message}));return;}
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify(job.result||{success:false,error:job.message}));
    return;
  }

  if(req.method!=='POST'){res.writeHead(404);res.end(JSON.stringify({error:'Not found'}));return;}

  let body='';
  req.on('data',c=>{body+=c;});
  req.on('end',async()=>{
    let p;try{p=JSON.parse(body);}catch(e){res.writeHead(400);res.end(JSON.stringify({error:'Bad JSON'}));return;}
    if(SECRET&&p.secret!==SECRET){res.writeHead(403);res.end(JSON.stringify({error:'Geweigerd.'}));return;}
    const{username,password,force_refresh}=p;
    if(!username||!password){res.writeHead(400);res.end(JSON.stringify({error:'Credentials verplicht.'}));return;}

    if(req.url==='/debug'){
      try{const r=await debugScrape(username,password);res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(r));}
      catch(err){res.writeHead(500);res.end(JSON.stringify({error:err.message}));}
      return;
    }

    if(req.url==='/scrape'){
      // Cache check
      // Cache uitgeschakeld: elke sync-aanvraag haalt altijd verse data op.
      // (force_refresh wordt genegeerd, want we willen nooit stale data tonen)
      // Start async job
      const jid=jobId();
      jobs[jid]={status:'starting',message:'Job gestart...',result:null};
      // Stuur direct job_id terug
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({job_id:jid,status:'starting',async:true}));
      // Run op de achtergrond
      runScrape(username,password,jobs[jid]).catch(err=>{
        jobs[jid].status='error';jobs[jid].message=err.message;
      });
      return;
    }

    res.writeHead(404);res.end(JSON.stringify({error:'Niet gevonden.'}));
  });
});

server.listen(PORT,'0.0.0.0',()=>{
  log('INFO',`Elit Scraper v8b op poort ${PORT}`);
  if(!SECRET) log('WARN','Geen SECRET!');
});
process.on('unhandledRejection',r=>log('ERROR',String(r)));
