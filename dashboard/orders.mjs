// Cloud Toast collector. Only anonymous minute aggregates reach the app.
import fs from 'node:fs';import path from 'node:path';
import {storeNames,businessClock,baselineDates,aggregateOrders,aggregateSales,salesAt,buildStore,service,shiftDate} from './order-pace-model.mjs';
import {inRefreshWindow,nextRefresh} from './refresh-schedule.mjs';
import {needsMorning,morningError} from './morning-state.mjs';
const root=process.cwd(),stateDir=path.join(process.env.DASHBOARD_DATA_DIR||'/data/dashboard','orders');fs.mkdirSync(stateDir,{recursive:true});
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const target=path.join(stateDir,'snapshot.json'),cacheFile=path.join(stateDir,'cache.json'),watch=process.argv.includes('--watch'),autoRefresh=watch||process.argv.includes('--scheduled');
const atomic=(file,data)=>{fs.writeFileSync(file+'.tmp',JSON.stringify(data,null,2));fs.renameSync(file+'.tmp',file);};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function readDay(client,name,date){const asOf=new Date().toISOString(),orders=[];for(let page=1;page<=100;page++){let data;for(let attempt=0;attempt<3;attempt++){try{const r=await client.callTool({name:'toast_list_orders',arguments:{restaurantGuid:name,businessDate:Number(date.replaceAll('-','')),page,pageSize:100}},undefined,{timeout:60000});if(r.isError)throw Error('Order source failed');data=JSON.parse(r.content.find(c=>c.type==='text').text);if(!Array.isArray(data.orders)||data.pagination?.page!==page||typeof data.pagination?.hasMore!=='boolean')throw Error('Incomplete order page');break;}catch{if(attempt===2)throw Error('Order read failed');await pause((attempt+1)*2000);}}
 orders.push(...data.orders);await pause(500);if(!data.pagination.hasMore)return {date,minutes:aggregateOrders(orders,date,asOf),sales:aggregateSales(orders,date,asOf),fetchedAt:asOf};}throw Error('Order pagination exceeded bound');}

async function collect(){
 const now=new Date().toISOString(),clock=businessClock(now),prior=fs.existsSync(target)?JSON.parse(fs.readFileSync(target,'utf8')):{stores:[]},cache=fs.existsSync(cacheFile)?JSON.parse(fs.readFileSync(cacheFile,'utf8')):{};
 const client=new Client({name:'store-pulse-orders',version:'1.1.0'}),result=[];let connected=false;
 const expectedLastService=shiftDate(clock.businessDate,-1);
 const morningNeeded=name=>needsMorning(cache,name,clock.businessDate);
 const needsSource=storeNames.some(name=>service(name,clock.businessDate,clock.minute).state==='open'||morningNeeded(name));
 if(needsSource)try{const url=process.env.TOAST_MCP_URL;if(!url)throw Error('Toast connection missing');await client.connect(new StreamableHTTPClientTransport(new URL(url)));connected=true;}catch{}
 for(const name of storeNames){
  const morningKey='morningTries:'+name+':'+clock.businessDate;
  if(morningNeeded(name)){cache[morningKey]=(Number(cache[morningKey])||0)+1;try{if(!connected)throw Error('Toast unavailable');const previous=await readDay(client,name,expectedLastService);cache['lastService:'+name]={date:previous.date,count:previous.minutes.length,netSales:salesAt(previous.sales,1680),fetchedAt:previous.fetchedAt};cache['morningSuccess:'+name+':'+clock.businessDate]=now;delete cache['morningError:'+name];}catch{cache['morningError:'+name]={at:now,expectedDate:expectedLastService,attempts:cache[morningKey]};}}
  const lastServiceError=morningError(cache,name,clock.businessDate);
  const lastService=cache['lastService:'+name]||null,storeService=service(name,clock.businessDate,clock.minute),previous=prior.stores.find(s=>s.name===name);
  if(storeService.state!=='open'){
   const saved=previous?.businessDate===clock.businessDate?previous:null;
   result.push({...saved,name,businessDate:clock.businessDate,minute:saved?.minute??clock.minute,service:storeService,state:'paused',lastAttemptAt:saved?.lastAttemptAt||null,dataAsOf:saved?.dataAsOf||null,actual:saved?.actual??null,baseline:saved?.baseline??null,delta:saved?.delta??null,baselineDays:saved?.baselineDays||[],chart:saved?.chart||[],lastService,lastServiceError});continue;
  }
  let actual=null,error=false;const baselines=[];
  if(connected){for(const date of baselineDates(clock.businessDate)){const key=name+':'+date;try{let value=cache[key];if(!value||!Array.isArray(value.sales)||Date.now()-Date.parse(value.fetchedAt)>86400000){value=await readDay(client,name,date);cache[key]=value;}baselines.push(value);}catch{error=true;}}
   try{actual=await readDay(client,name,clock.businessDate);}catch{error=true;}}
  result.push({...buildStore({name,now,actual,baselines,previous,error:error||!connected}),lastService,lastServiceError});
 }
 await client.close();const done=new Date().toISOString();if(businessClock(done).businessDate!==clock.businessDate)throw Error('Business day changed during refresh');
 atomic(cacheFile,cache);atomic(target,{schemaVersion:1,mode:autoRefresh?'cloud-auto':'manual',generatedAt:done,businessDate:clock.businessDate,timezone:'America/Chicago',intervalSeconds:3600,nextExpectedAt:nextRefresh(),stores:result});
 console.log(JSON.stringify({state:'checked',businessDate:clock.businessDate,stores:result.map(s=>({name:s.name,orders:s.actual,state:s.state,lastService:s.lastService})),nextExpectedAt:nextRefresh()}));
}
do{if(inRefreshWindow())try{await collect();}catch{console.log('Order refresh failed; last complete snapshot retained.');if(!watch)process.exitCode=1;}if(!watch)break;await pause(Math.max(1000,Date.parse(nextRefresh())-Date.now()));}while(watch);
