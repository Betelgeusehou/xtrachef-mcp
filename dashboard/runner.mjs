import {classifierVersion} from './prime-cost-model.mjs';
import {recordRefresh,recoverInvoiceActivity} from './activity.mjs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {inRefreshWindow,nextRefresh} from './refresh-schedule.mjs';
import {dataDir,atomic,load} from './state.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
let running=false;
let primeRequested=false;
function run(script,args=[]){return new Promise(resolve=>{const child=spawn(process.execPath,[path.join(here,script),'--scheduled',...args],{stdio:['ignore','ignore','ignore'],env:process.env});const timeout=setTimeout(()=>{child.kill('SIGKILL');resolve({source:script,ok:false,reason:'timeout'});},15*60*1000);child.once('error',()=>{clearTimeout(timeout);resolve({source:script,ok:false,reason:'start failed'});});child.once('exit',code=>{clearTimeout(timeout);resolve({source:script,ok:code===0});});});}
export async function runSource(script,args=[],{env=process.env,execute=run}={}){
 if(script==='refresh-sandcastles.mjs'&&env.SANDCASTLES_ENABLED!=='true')return {source:script,ok:true,skipped:true,outcome:'disabled',reason:'SANDCASTLES_ENABLED is not true'};
 return execute(script,args);
}
export async function tick(now=new Date()){
 if(running||!inRefreshWindow(now)||process.env.DASHBOARD_ENABLED!=='true')return;
 const hour=now.toISOString().slice(0,13),statusFile=path.join(dataDir(),'run-status.json');
 if(primeRequested){primeRequested=false;running=true;try{const results=[];for(const target of invoiceTargets()){const result=await run('prime.mjs',target==='primePrevious'?['--previous-month']:[]);results.push({...result,target});recordRefresh({...result,source:target+'-invoice-retry'},new Date().toISOString());}atomic(path.join(dataDir(),'invoice-refresh-status.json'),{completedAt:new Date().toISOString(),ok:results.every(r=>r.ok),results});}finally{running=false;}return;}
 const prior=load(statusFile);
 if(prior?.hour===hour&&prior.state!=='running')return;
 running=true;atomic(statusFile,{hour,state:'running',startedAt:now.toISOString(),nextExpectedAt:nextRefresh(now)});
 try{const results=[];for(const script of ['orders.mjs','prime.mjs','refresh-beehiiv.mjs','refresh-klaviyo.mjs','refresh-sandcastles.mjs'])results.push(await runSource(script));for(const result of results)recordRefresh(result,hour);const previous=load(path.join(dataDir(),'primePrevious','snapshot.json'));if(!previous||Date.now()-Date.parse(previous.generatedAt)>86400000){const result=await run('prime.mjs',['--previous-month']);results.push(result);recordRefresh({...result,source:'prime-previous-month'},hour);}atomic(statusFile,{hour,state:results.every(r=>r.ok)?'ready':'partial',completedAt:new Date().toISOString(),nextExpectedAt:nextRefresh(),results});}catch{atomic(statusFile,{hour,state:'error',completedAt:new Date().toISOString(),nextExpectedAt:nextRefresh()});}finally{running=false;}
}
export function invoiceRefreshTargets(store,current,previous,now=new Date()){
 const imported=Date.parse(store?.last_ingest);if(!Number.isFinite(imported))return [];
 const local=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Chicago',year:'numeric',month:'2-digit'}).formatToParts(now);const year=Number(local.find(p=>p.type==='year').value),month=Number(local.find(p=>p.type==='month').value);const previousMonth=new Date(Date.UTC(year,month-2,1)).toISOString().slice(0,7);
 const targets=[];if(current?.classifierVersion!==classifierVersion||!(Date.parse(current?.generatedAt)>=imported))targets.push('prime');
 if(store.lines?.some(line=>line.invoice_date?.startsWith(previousMonth))&&(previous?.classifierVersion!==classifierVersion||!(Date.parse(previous?.generatedAt)>=imported)))targets.push('primePrevious');
 return targets;
}
function invoiceTargets(){return invoiceRefreshTargets(load(path.join(dataDir(),'invoices/lines.json')),load(path.join(dataDir(),'prime/snapshot.json')),load(path.join(dataDir(),'primePrevious/snapshot.json')));}
export function requestPrimeRefresh(){primeRequested=true;void tick();}
export function startDashboardRunner(){try{recoverInvoiceActivity();}catch{console.error('Dashboard invoice activity recovery failed');}if(process.env.DASHBOARD_ENABLED!=='true')return;primeRequested=invoiceTargets().length>0;void tick();const timer=setInterval(()=>void tick(),60000);timer.unref();}
