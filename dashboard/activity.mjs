import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
const directory=()=>path.join(process.env.DASHBOARD_DATA_DIR||'/data/dashboard','activity');
export function activityEvents(limit=100){const dir=directory();if(!fs.existsSync(dir))return [];return fs.readdirSync(dir).filter(n=>n.endsWith('.json')).map(n=>JSON.parse(fs.readFileSync(path.join(dir,n),'utf8'))).sort((a,b)=>b.occurredAt.localeCompare(a.occurredAt)||a.id.localeCompare(b.id)).slice(0,limit);}
export function appendActivity(event){
 if(!event||event.schemaVersion!==1||typeof event.id!=='string'||!/^[-a-zA-Z0-9_:.]{1,160}$/.test(event.id)||!['refresh','invoice_import','invoice_cleanup'].includes(event.kind)||!['succeeded','failed','skipped','verified'].includes(event.outcome)||typeof event.summary!=='string'||event.summary.length>300||!Number.isFinite(Date.parse(event.occurredAt))||Date.parse(event.occurredAt)>Date.now()+300000)throw Error('Invalid activity');
 const dir=directory();fs.mkdirSync(dir,{recursive:true,mode:0o700});const file=path.join(dir,crypto.createHash('sha256').update(event.id).digest('hex')+'.json');
 if(fs.existsSync(file)){const prior=JSON.parse(fs.readFileSync(file,'utf8'));if(JSON.stringify(prior)!==JSON.stringify(event))throw Error('Conflicting activity identity');return false;}
 fs.writeFileSync(file+'.tmp',JSON.stringify(event),{mode:0o600});fs.renameSync(file+'.tmp',file);
 // Audit cleanup records remain durable; routine refresh history is bounded separately.
 const routine=activityEvents(Number.MAX_SAFE_INTEGER).filter(e=>e.kind==='refresh');for(const old of routine.slice(1000))fs.unlinkSync(path.join(dir,crypto.createHash('sha256').update(old.id).digest('hex')+'.json'));
 return true;
}
export function recordRefresh(result,hour,occurredAt=new Date().toISOString()){
 const outcome=result.skipped?'skipped':result.ok?'succeeded':'failed';
 const id='refresh:'+hour+':'+result.source+':'+outcome;
 if(activityEvents(Number.MAX_SAFE_INTEGER).some(e=>e.id===id))return false;
 return appendActivity({schemaVersion:1,id,occurredAt,kind:'refresh',source:result.source,outcome,summary:result.skipped?'Source refresh skipped: disabled':result.ok?'Source refresh completed':'Source refresh failed; last successful readings retained'});
}
export function ingestCleanup(value){
 if(!value||Object.keys(value).some(k=>!['operationId','occurredAt','verifiedAt','affectedCount','evidenceSha256'].includes(k))||typeof value.operationId!=='string'||!/^[-a-zA-Z0-9_]{1,100}$/.test(value.operationId)||!Number.isInteger(value.affectedCount)||value.affectedCount<1||!/^([a-f0-9]{64})$/.test(value.evidenceSha256))throw Error('Invalid cleanup evidence');
 const at=Date.parse(value.occurredAt),verified=Date.parse(value.verifiedAt);if(!Number.isFinite(at)||!Number.isFinite(verified)||verified<at||verified>Date.now()+300000)throw Error('Invalid verification time');
 return appendActivity({schemaVersion:1,id:'cleanup:'+value.operationId,occurredAt:new Date(at).toISOString(),kind:'invoice_cleanup',source:'xtrachef',outcome:'verified',summary:'Invoice cleanup verified by operator',evidence:{operationId:value.operationId,verifiedAt:new Date(verified).toISOString(),affectedCount:value.affectedCount,evidenceSha256:value.evidenceSha256}});
}

export function recordInvoiceImport(store){
 const manifest=store?.dashboardManifest;if(!manifest?.sha256||!Array.isArray(store.lines))return false;
 const id='invoice-import:'+manifest.sha256;
 if(activityEvents(Number.MAX_SAFE_INTEGER).some(e=>e.id===id))return false;
 return appendActivity({schemaVersion:1,id,occurredAt:store.last_ingest||manifest.importedAt,kind:'invoice_import',source:'xtrachef',outcome:'verified',summary:'Invoice export reconciled and imported',evidence:{operationId:manifest.sha256,verifiedAt:store.last_ingest||manifest.importedAt,invoiceCount:manifest.invoiceCount,lineCount:store.lines.length,exportSha256:manifest.sha256}});
}
export function recoverInvoiceActivity(){
 const file=path.join(process.env.DASHBOARD_DATA_DIR||'/data/dashboard','invoices','lines.json');
 if(!fs.existsSync(file))return false;
 return recordInvoiceImport(JSON.parse(fs.readFileSync(file,'utf8')));
}
