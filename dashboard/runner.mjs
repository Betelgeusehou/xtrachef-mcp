import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {inRefreshWindow,nextRefresh} from './refresh-schedule.mjs';
import {dataDir,atomic,load} from './state.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
let running=false;
let primeRequested=false;
function run(script,args=[]){return new Promise(resolve=>{const child=spawn(process.execPath,[path.join(here,script),'--scheduled',...args],{stdio:['ignore','ignore','ignore'],env:process.env});const timeout=setTimeout(()=>{child.kill('SIGKILL');resolve({source:script,ok:false,reason:'timeout'});},15*60*1000);child.once('error',()=>{clearTimeout(timeout);resolve({source:script,ok:false,reason:'start failed'});});child.once('exit',code=>{clearTimeout(timeout);resolve({source:script,ok:code===0});});});}
export async function tick(now=new Date()){
 if(running||!inRefreshWindow(now)||process.env.DASHBOARD_ENABLED!=='true')return;
 const hour=now.toISOString().slice(0,13),statusFile=path.join(dataDir(),'run-status.json');
 if(primeRequested){primeRequested=false;running=true;try{const result=await run('prime.mjs');atomic(path.join(dataDir(),'invoice-refresh-status.json'),{completedAt:new Date().toISOString(),...result});}finally{running=false;}return;}
 const prior=load(statusFile);
 if(prior?.hour===hour&&prior.state!=='running')return;
 running=true;atomic(statusFile,{hour,state:'running',startedAt:now.toISOString(),nextExpectedAt:nextRefresh(now)});
 try{const results=[];for(const script of ['orders.mjs','prime.mjs','refresh-beehiiv.mjs','refresh-klaviyo.mjs','refresh-sandcastles.mjs'])results.push(await run(script));const previous=load(path.join(dataDir(),'primePrevious','snapshot.json'));if(!previous||Date.now()-Date.parse(previous.generatedAt)>86400000)results.push(await run('prime.mjs',['--previous-month']));atomic(statusFile,{hour,state:results.every(r=>r.ok)?'ready':'partial',completedAt:new Date().toISOString(),nextExpectedAt:nextRefresh(),results});}catch{atomic(statusFile,{hour,state:'error',completedAt:new Date().toISOString(),nextExpectedAt:nextRefresh()});}finally{running=false;}
}
export function requestPrimeRefresh(){primeRequested=true;void tick();}
export function startDashboardRunner(){if(process.env.DASHBOARD_ENABLED!=='true')return;void tick();const timer=setInterval(()=>void tick(),60000);timer.unref();}
