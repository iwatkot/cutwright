import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { chromium } from 'playwright-core';

// Portable owned browser editor. No account/global client configuration, project reset or automatic export.
const root=fileURLToPath(new URL('../',import.meta.url));
const [command='status',...argv]=process.argv.slice(2);
const options=Object.fromEntries(argv.map(arg=>{const i=arg.indexOf('=');return i<0?[arg.replace(/^--/,''),true]:[arg.slice(2,i),arg.slice(i+1)];}));
const state=path.resolve(String(options.state??path.join(root,'.local','browser-editor')));
const configPath=path.join(state,'config.json'), statusPath=path.join(state,'status.json');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const request=async(url,init)=>{const response=await fetch(url,{...init,signal:AbortSignal.timeout(10000)});if(!response.ok)throw Error(`Local service ${response.status}: ${url}`);return response.json();};
const call=async(config,name,args={})=>{const result=await request(`${config.adapter}/call`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,arguments:args})});if(!result.structuredContent?.ok)throw Error(JSON.stringify(result.structuredContent??result));return result.structuredContent;};
const writeStatus=value=>fs.writeFileSync(statusPath,JSON.stringify(value,null,2)+'\n');
function validPort(value){const port=Number(value);if(!Number.isInteger(port)||port<1024||port>65535)throw Error('Ports must be integers1024..65535.');return port;}
async function available(port){await new Promise((resolve,reject)=>{const server=net.createServer();server.once('error',()=>reject(Error(`Port ${port} is in use; inspect its owner or choose another port.`)));server.listen(port,'127.0.0.1',()=>server.close(resolve));});}
async function connectUi(page,config){
  if(!await page.getByRole('dialog',{name:'Agent connection',exact:true}).count())await page.getByRole('button',{name:'Agent',exact:true}).click();
  await page.getByRole('button',{name:'Codex',exact:true}).click();
  if(await page.getByRole('button',{name:'Set up Codex',exact:true}).count())await page.getByRole('button',{name:'Set up Codex',exact:true}).click();
  const raw=await request(`${config.adapter}/call`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'get_project',arguments:{}})});
  if(!raw.structuredContent?.ok){
    const session=raw.structuredContent?.error?.message?.match(/choose ([^.]+)\. Keep/)?.[1];
    await page.getByRole('button',{name:'Connect',exact:true}).first().click();
    await page.waitForTimeout(400);
    if(!await page.getByText('Connected to Codex',{exact:true}).count()){
      if(!session)throw Error('Cannot identify the owned connector session. Inspect adapter health/logs.');
      await page.getByRole('button',{name:new RegExp(session)}).click();
    }
    await page.getByText('Connected to Codex',{exact:true}).waitFor();
  }
  await page.getByRole('button',{name:'Close connection settings'}).click();
}

if(command==='start'){
  fs.mkdirSync(state,{recursive:true});
  if(fs.existsSync(statusPath)){
    const previous=read(statusPath);
    if(previous.phase==='ready'){
      try{const health=await request(`${previous.adapter}/health`);if(health.pid===previous.adapterPid){console.log(JSON.stringify(previous,null,2));process.exit(0);}}catch{}
    }
    if(previous.ownerPid){try{process.kill(previous.ownerPid,0);throw Error('Recorded owner still exists. Inspect status/logs; do not start a duplicate.');}catch(error){if(error.code!=='ESRCH')throw error;}}
  }
  const port=validPort(options.port??5173),mcpPort=validPort(options['mcp-port']??47903),cdpPort=validPort(options['cdp-port']??9224);
  if(new Set([port,mcpPort,cdpPort]).size!==3)throw Error('App, MCP and CDP ports must differ.');
  for(const candidatePort of [port,mcpPort,cdpPort])await available(candidatePort);
  const versionPath=path.join(root,'dist','version.json');if(!fs.existsSync(versionPath))throw Error('Run npm run build:web first.');
  const version=read(versionPath),commit=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
  if(version.commit!==commit&&!options['allow-dirty'])throw Error('The browser build is from another revision. Rebuild before starting.');
  const executable=options.executable?path.resolve(String(options.executable)):chromium.executablePath();
  if(!fs.existsSync(executable))throw Error('Install the supported browser: node node_modules/playwright-core/cli.js install chromium');
  const profile=path.resolve(String(options.profile??path.join(state,'profile')));
  if(fs.existsSync(profile)&&fs.readdirSync(profile).length){
    const backup=path.join(state,'profile-backups',new Date().toISOString().replace(/[:.]/g,'-'));
    fs.cpSync(profile,backup,{recursive:true,errorOnExist:true,force:false});
    fs.appendFileSync(path.join(state,'owner.log'),`Preserved stopped profile before navigation: ${backup}\n`);
  }
  // Serve an immutable snapshot: rebuilding source cannot replace lazy chunks during a render.
  const snapshot=path.join(state,'builds',`${Date.now()}-${String(version.commit).slice(0,12)}`);fs.cpSync(path.join(root,'dist'),snapshot,{recursive:true,errorOnExist:true,force:false});
  const config={root,state,profile,snapshot,executable,port,mcpPort,cdpPort,origin:`http://127.0.0.1:${port}`,adapter:`http://127.0.0.1:${mcpPort}`,cdp:`http://127.0.0.1:${cdpPort}`,headed:!!options.headed,version,task:`CutWright Browser ${port}`};
  fs.writeFileSync(configPath,JSON.stringify(config,null,2)+'\n');writeStatus({...config,phase:'starting'});
  if(process.platform==='win32')execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(root,'scripts','start-browser-editor-task.ps1'),'-TaskName',config.task,'-NodeBinary',process.execPath,'-OwnerScript',fileURLToPath(import.meta.url),'-StateDirectory',state],{stdio:'inherit',windowsHide:true});
  else{const log=fs.openSync(path.join(state,'owner.log'),'a');const owner=spawn(process.execPath,[fileURLToPath(import.meta.url),'owner',`--state=${state}`],{cwd:root,detached:true,stdio:['ignore',log,log]});owner.unref();fs.closeSync(log);}
  for(let i=0;i<180;i++){const status=read(statusPath);if(status.phase==='ready'){console.log(JSON.stringify(status,null,2));process.exit(0);}if(status.phase==='error')throw Error(status.error);await delay(1000);}
  throw Error(`Startup is still pending. Inspect ${path.join(state,'owner.log')}; do not launch another owner.`);
}else if(command==='owner'){
  const config=read(configPath),log=fs.openSync(path.join(state,'owner.log'),'a');const children=[];let context,server,stopping=false;
  const logger=value=>fs.writeSync(log,`${new Date().toISOString()} ${value}\n`);
  const stop=async()=>{if(stopping)return;stopping=true;try{const health=await request(`${config.adapter}/health`);if(health.pid===children[0]?.pid)try{process.kill(health.connectorPid);}catch{}}catch{}for(const child of children)child.kill();server?.closeAllConnections();await new Promise(resolve=>server?.close(resolve)??resolve());writeStatus({...read(statusPath),phase:'stopped'});process.exit(0);};
  process.on('SIGINT',()=>void context?.close().finally(stop));process.on('SIGTERM',()=>void context?.close().finally(stop));
  try{
    const mime={'.js':'text/javascript','.cjs':'text/javascript','.css':'text/css','.html':'text/html','.json':'application/json','.wasm':'application/wasm','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon','.mcpb':'application/octet-stream','.ttf':'font/ttf','.woff2':'font/woff2'};
    server=http.createServer(async(req,res)=>{try{
      res.setHeader('Cache-Control','no-store');res.setHeader('Cross-Origin-Opener-Policy','same-origin');res.setHeader('Cross-Origin-Embedder-Policy','require-corp');
      const name=decodeURIComponent(new URL(req.url,config.origin).pathname);let file=path.resolve(config.snapshot,'.'+name);
      if(file!==config.snapshot&&!file.startsWith(config.snapshot+path.sep))throw Error('Invalid path');
      if(fs.existsSync(file)&&fs.statSync(file).isDirectory())file=path.join(file,'index.html');
      if(!fs.existsSync(file)){if(path.extname(name)){res.writeHead(404);res.end();return;}file=path.join(config.snapshot,'index.html');}
      res.setHeader('Content-Type',mime[path.extname(file)]??'application/octet-stream');fs.createReadStream(file).pipe(res);
    }catch{res.writeHead(400);res.end();}});
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(config.port,'127.0.0.1',resolve);});
    const connector=path.join(config.snapshot,'connectors',config.version.version,`cutwright-connector-${config.version.version}.cjs`);
    children.push(spawn(process.execPath,[path.join(root,'scripts','browser-agent-session.mjs'),`--port=${config.mcpPort}`,`--connector=${connector}`],{cwd:root,windowsHide:true,stdio:['ignore',log,log]}));
    let health;for(let i=0;i<100;i++){try{health=await request(`${config.adapter}/health`);break;}catch{await delay(100);}}if(!health)throw Error('Owned MCP adapter did not start.');
    context=await chromium.launchPersistentContext(config.profile,{executablePath:config.executable,headless:!config.headed,acceptDownloads:false,viewport:{width:1600,height:1000},args:[`--remote-debugging-port=${config.cdpPort}`,'--remote-debugging-address=127.0.0.1','--no-proxy-server']});
    const browserSession=await context.browser().newBrowserCDPSession();
    const browserPid=(await browserSession.send('SystemInfo.getProcessInfo')).processInfo.find(item=>item.type==='browser')?.id;
    if(!browserPid)throw Error('Cannot verify the owned browser process identity.');
    context.on('close',()=>void stop());const page=context.pages()[0]??await context.newPage();page.on('pageerror',error=>logger(String(error)));
    await page.goto(config.origin+'/?lang=en');await page.getByRole('button',{name:'Agent',exact:true}).waitFor();await connectUi(page,config);
    const project=await call(config,'get_project'),tools=await request(`${config.adapter}/tools`);
    writeStatus({...config,phase:'ready',ownerPid:process.pid,browserPid,adapterPid:health.pid,connectorPid:health.connectorPid,revision:project.revision,toolCount:tools.tools.length,nativeDownloads:'denied; use save_download',startedAt:new Date().toISOString()});logger('Ready; project preserved; no export started.');
  }catch(error){stopping=true;logger(error.stack??error);writeStatus({...config,phase:'error',ownerPid:process.pid,error:String(error)});await context?.close();try{const health=await request(`${config.adapter}/health`);if(health.pid===children[0]?.pid)process.kill(health.connectorPid);}catch{}for(const child of children)child.kill();server?.close();process.exit(1);}
}else if(['status','screenshot','stop'].includes(command)){
  if(!fs.existsSync(configPath))throw Error(`No owned session at ${state}. Run start first.`);const config=read(configPath),status=read(statusPath);
  if(command==='status'){const health=await request(`${config.adapter}/health`),project=await call(config,'get_project');console.log(JSON.stringify({...status,health,revision:project.revision},null,2));}
  else{
    const browser=await chromium.connectOverCDP(config.cdp,{noDefaults:true});try{
      const page=browser.contexts().flatMap(c=>c.pages()).find(page=>page.url().startsWith(config.origin+'/'));if(!page)throw Error('Owned editor tab is unavailable.');
      if(command==='screenshot'){if(!options.output)throw Error('Provide --output=<new PNG path>.');const output=path.resolve(String(options.output));if(fs.existsSync(output))throw Error('Screenshot destination already exists.');await page.screenshot({path:output});console.log(output);}
      else{if(await page.locator('#export-btn.export-running').count())throw Error('An export is running. Cancel it through MCP and wait for terminal status before stopping.');const session=await browser.newBrowserCDPSession();const info=await session.send('SystemInfo.getProcessInfo');if(!status.browserPid||!info.processInfo.some(item=>item.type==='browser'&&item.id===status.browserPid))throw Error('Browser process ownership differs; refusing to close it.');await session.send('Browser.close').catch(()=>{});console.log('Owned browser stopped; profile and outputs preserved.');}
    }finally{await browser.close().catch(()=>{});}
  }
}else throw Error('Use start, status, screenshot or stop.');
