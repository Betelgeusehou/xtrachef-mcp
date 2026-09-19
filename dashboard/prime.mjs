// Cloud collector. Source credentials remain in process environment only.
import fs from 'node:fs';
import path from 'node:path';
import {businessPeriod,dateRange,makeSnapshot,stores,auditWages} from './prime-cost-model.mjs';
import {fileURLToPath} from 'node:url';
import {inRefreshWindow,nextRefresh} from './refresh-schedule.mjs';
const root=path.dirname(fileURLToPath(import.meta.url));
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const previousMonth=process.argv.includes('--previous-month');
const stateDir=path.join(process.env.DASHBOARD_DATA_DIR||'/data/dashboard',previousMonth?'primePrevious':'prime'), snapshotPath=path.join(stateDir,'snapshot.json');
fs.mkdirSync(stateDir,{recursive:true});
const cachePath=path.join(stateDir,'toast-cache.json');
const watch=process.argv.includes('--watch'),autoRefresh=watch||process.argv.includes('--scheduled');
const auditCachePath=path.join(stateDir,previousMonth?'audited-previous-month.json':'audited-days.json');
const write=(file,value)=>{fs.writeFileSync(file+'.tmp',JSON.stringify(value,null,2));fs.renameSync(file+'.tmp',file)};
async function read(client,name,args={}) {
 const response=await client.callTool({name,arguments:args},undefined,{timeout:90000});
 if(response.isError)throw new Error('Source read failed');
 return JSON.parse(response.content.find(x=>x.type==='text').text);
}
async function collect(){
 const now=new Date().toISOString(), period=businessPeriod();
 if(previousMonth){const end=new Date(period.from+'T12:00:00Z');end.setUTCDate(0);period.through=end.toISOString().slice(0,10);period.from=period.through.slice(0,7)+'-01';}
 const through=period.through;
 const monday=new Date(through+'T12:00:00Z');monday.setUTCDate(monday.getUTCDate()-(monday.getUTCDay()+6)%7);
 const from=previousMonth?period.from:[period.from,monday.toISOString().slice(0,10)].sort()[0];
 const toast=new Client({name:'store-pulse-prime',version:'1.0.0'});
 let stage='configuration';
 try {
  const url=process.env.TOAST_MCP_URL;if(!url)throw new Error('Toast configuration missing');
  stage='verified invoice read';
  const invoiceFile=process.env.DASHBOARD_INVOICE_FILE||path.join(process.env.DASHBOARD_DATA_DIR||'/data/dashboard','invoices','lines.json');
  const invoiceStore=JSON.parse(fs.readFileSync(invoiceFile,'utf8'));
  if(!Array.isArray(invoiceStore.lines)||!invoiceStore.lines.length||!invoiceStore.last_ingest)throw new Error('Verified invoice store missing');
  const invoiceResult={lines:invoiceStore.lines.filter(line=>line.invoice_date>=from&&line.invoice_date<=through)};
  const invoiceDates=invoiceStore.lines.map(line=>line.invoice_date).filter(Boolean).sort();
  const status={last_ingest:invoiceStore.last_ingest,invoice_date_range:{from:invoiceDates[0],to:invoiceDates.at(-1)}};
  const invoiceImport={...invoiceStore.dashboardManifest,source:invoiceStore.dashboardManifest?.source||'verified cloud invoice store',lastIngestAt:invoiceStore.last_ingest};
  stage='salary baseline';const salaryBaseline=JSON.parse(fs.readFileSync(path.join(root,'prime-salary-baseline.json'),'utf8'));
  const savedAudit=fs.existsSync(auditCachePath)?JSON.parse(fs.readFileSync(auditCachePath,'utf8')):null;
  if(savedAudit&&savedAudit.from===from&&savedAudit.through===through&&Date.now()-Date.parse(savedAudit.fetchedAt)<86400000){
   const completedAt=new Date().toISOString();const snapshot=makeSnapshot({from,through,invoices:invoiceResult.lines,status,records:savedAudit.records,salaryBaseline,now:completedAt,refresh:{mode:autoRefresh?'cloud-auto':'manual',lastAttemptAt:now,lastSuccessAt:completedAt,nextExpectedAt:autoRefresh?nextRefresh():null,state:'ready',intervalMinutes:autoRefresh?60:null}});
   snapshot.toastFetchedAt=savedAudit.fetchedAt;snapshot.toastOldestReadAt=savedAudit.oldestReadAt;snapshot.laborAudit=savedAudit.laborAudit;snapshot.invoiceImport=invoiceImport;write(snapshotPath,snapshot);console.log(JSON.stringify({state:'ready',through,source:'cached completed-day Toast audit; invoice data checked',completedAt}));return;
  }
  stage='Toast connection';await toast.connect(new StreamableHTTPClientTransport(new URL(url)));
  const cache=fs.existsSync(cachePath)?JSON.parse(fs.readFileSync(cachePath,'utf8')):{};
  const dates=dateRange(from,through), recent=new Set(dates.slice(-2)), records=[];
  for(const restaurantGuid of stores)for(const date of dates)for(const type of ['sales','labor']){
   const businessDate=Number(date.replaceAll('-','')),key=`${restaurantGuid}:${businessDate}:${type}`;
   stage=key;let entry=cache[key];
   if(!entry||Date.now()-Date.parse(entry.fetchedAt)>86400000){
    let result;for(let attempt=0;attempt<3;attempt++){try{result=await read(toast,type==='sales'?'toast_get_sales_summary':'toast_get_labor_report',{restaurantGuid,businessDate});if(result.businessDate!==businessDate||!Number.isFinite(result[type==='sales'?'netSales':'totalWages']))throw new Error('Invalid source response');break}catch{if(attempt===2)throw new Error('Toast refresh failed');await new Promise(resolve=>setTimeout(resolve,2000*(attempt+1)));}}
    entry={restaurantGuid,businessDate,type,data:result,error:false,fetchedAt:new Date().toISOString()};cache[key]=entry;write(cachePath,cache);await new Promise(resolve=>setTimeout(resolve,1000));
   }
   records.push(structuredClone(entry));
  }
  stage='labor reconciliation';
  const laborAudit={ownerExcluded:0,managerOverlap:0,missingWageEntries:0};
  const rangeStart=new Date(from+'T00:00:00Z');rangeStart.setUTCDate(rangeStart.getUTCDate()-1);
  const rangeEnd=new Date(through+'T00:00:00Z');rangeEnd.setUTCDate(rangeEnd.getUTCDate()+2);
  for(const restaurantGuid of stores){
   const employees=await read(toast,'toast_list_employees',{restaurantGuid,includeDeleted:true});
   const uniqueEntries=new Map();
   for(let start=new Date(rangeStart);start<rangeEnd;){
    const end=new Date(Math.min(start.getTime()+7*86400000,rangeEnd.getTime()));
    const entries=await read(toast,'toast_list_time_entries',{restaurantGuid,compact:true,startDate:start.toISOString(),endDate:end.toISOString()});
    if(!Array.isArray(entries.timeEntries)||entries.count!==entries.timeEntries.length)throw new Error('Incomplete wage audit');
    for(const entry of entries.timeEntries){if(!entry.guid)throw new Error('Incomplete wage audit');const prior=uniqueEntries.get(entry.guid);if(prior&&JSON.stringify(prior)!==JSON.stringify(entry))throw new Error('Wage source mismatch');uniqueEntries.set(entry.guid,entry);}
    start=end;
   }
   if(!Array.isArray(employees.employees))throw new Error('Incomplete wage audit');
   const audit=auditWages(employees.employees,[...uniqueEntries.values()],from,through);
   for(const r of records.filter(r=>r.restaurantGuid===restaurantGuid&&r.type==='labor')){
    const d=audit.byDay[r.businessDate]||{total:0,owner:0};
    if(Math.abs(d.total-r.data.totalWages)>0.005){
     const fresh=await read(toast,'toast_get_labor_report',{restaurantGuid,businessDate:r.businessDate});
     if(fresh.businessDate!==r.businessDate||!Number.isFinite(fresh.totalWages)||Math.abs(d.total-fresh.totalWages)>0.005)throw new Error('Wage source mismatch');
     r.data=fresh;r.fetchedAt=new Date().toISOString();cache[`${restaurantGuid}:${r.businessDate}:labor`]=structuredClone(r);
    }
    r.data.totalWages-=d.owner;
   }
   for(const key of Object.keys(laborAudit))laborAudit[key]+=audit[key];
  }
  const completedAt=new Date().toISOString();
  stage='validation';const snapshot=makeSnapshot({from,through,invoices:invoiceResult.lines,status,records,salaryBaseline,now:completedAt,refresh:{mode:autoRefresh?'cloud-auto':'manual',lastAttemptAt:now,lastSuccessAt:completedAt,nextExpectedAt:autoRefresh?nextRefresh():null,state:'ready',intervalMinutes:autoRefresh?60:null}});
  snapshot.toastOldestReadAt=records.map(r=>r.fetchedAt).sort()[0];
  snapshot.laborAudit=laborAudit;
  snapshot.invoiceImport=invoiceImport;
  write(auditCachePath,{from,through,fetchedAt:completedAt,oldestReadAt:snapshot.toastOldestReadAt,laborAudit,records:records.map(r=>({restaurantGuid:r.restaurantGuid,businessDate:r.businessDate,type:r.type,error:false,data:r.type==='sales'?{businessDate:r.businessDate,netSales:r.data.netSales}:{businessDate:r.businessDate,totalWages:r.data.totalWages}}))});
  write(cachePath,cache);write(snapshotPath,snapshot);
  console.log(JSON.stringify({state:'ready',through,invoiceLastImport:status.last_ingest,completedAt}));
 } catch (error) {
  if(['Incomplete wage audit','Owner identities unavailable','Duplicate time entry','Unmapped wage identity','Invalid wage entry','Wage source mismatch'].includes(error.message))console.log(JSON.stringify({auditIssue:error.message}));
  // Suppress SDK errors: URLs can contain secrets. Retain the last complete values.
  if(fs.existsSync(snapshotPath)){const prior=JSON.parse(fs.readFileSync(snapshotPath,'utf8'));prior.refresh={...prior.refresh,mode:autoRefresh?'cloud-auto':'manual',lastAttemptAt:now,nextExpectedAt:autoRefresh?nextRefresh():null,state:'error',message:'Refresh failed. Showing the last complete snapshot.'};write(snapshotPath,prior);}
  console.log(JSON.stringify({state:'error',stage,message:'Refresh failed; last complete values retained.'}));
  if(!watch)process.exitCode=1;
 } finally {await Promise.allSettled([toast.close()]);}
}
do { if(inRefreshWindow())await collect(); if(!watch)break; await new Promise(resolve=>setTimeout(resolve,Math.max(1000,Date.parse(nextRefresh())-Date.now()))); } while(watch);
