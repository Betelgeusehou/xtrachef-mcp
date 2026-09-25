import {recordInvoiceImport,ingestCleanup} from './activity.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {dataDir,atomic,load,snapshots,validateSnapshot,saveSnapshot} from './state.mjs';
import {readExport,reconcile,invoiceKey} from './invoice-import.mjs';
import {requestPrimeRefresh} from './runner.mjs';
const allowedLocations=new Set(['Montrose - Betelgeuse Betelgeuse','Washington - Betelgeuse Betelgeuse']);
export function authorized(header,key){if(typeof key!=='string'||key.length<32||typeof header!=='string')return false;return crypto.timingSafeEqual(crypto.createHash('sha256').update(header).digest(),crypto.createHash('sha256').update('Bearer '+key).digest());}
async function body(req){let size=0,parts=[];for await(const part of req){size+=part.length;if(size>16*1024*1024)throw Error('Payload too large');parts.push(part);}return JSON.parse(Buffer.concat(parts).toString('utf8'));}
export function importInvoices(envelope){
 const {lines,manifest}=envelope||{};
 if(!Array.isArray(lines)||!lines.length||!manifest||typeof manifest.rawCsv!=='string'||manifest.schemaVersion!==2||!Number.isInteger(manifest.invoiceCount)||manifest.invoiceCount<1)throw Error('Invalid invoice envelope');
 const hash=crypto.createHash('sha256').update(manifest.rawCsv).digest('hex');if(hash!==manifest.sha256)throw Error('Invoice hash mismatch');
 const parsed=readExport(manifest.rawCsv);if(parsed.groups.size!==manifest.invoiceCount)throw Error('Invoice count mismatch');
 for(const key of ['importedAt','exportFileAt'])if(!Number.isFinite(Date.parse(manifest[key]))||Date.parse(manifest[key])>Date.now()+300000)throw Error('Invalid invoice timestamp');
 const identities=new Set();
 for(const line of lines){if(!allowedLocations.has(line.location)||!line.vendor||!line.invoice_number||!Number.isFinite(line.line_total)||!Number.isFinite(line.invoice_total)||line.status!=='Completed'||!/^\d{4}-\d{2}-\d{2}$/.test(line.invoice_date))throw Error('Invalid invoice line');
  const identity=line.source_line_id||JSON.stringify([line.location,line.vendor,line.invoice_number,line.item_code,line.description,line.quantity,line.unit_price,line.line_total]);if(identities.has(identity))throw Error('Duplicate invoice line');identities.add(identity);
 }
 // Export group data is authoritative and freshly reconciled; never trust caller substitutions.
 const incoming=reconcile({lines},parsed),dir=path.join(dataDir(),'invoices'),file=path.join(dir,'lines.json');
 const prior=load(file),priorManifest=prior?.dashboardManifest;
 if(priorManifest&&Date.parse(manifest.exportFileAt)<Date.parse(priorManifest.exportFileAt))throw Error('Older invoice export rejected');
 if(priorManifest?.sha256===hash){recordInvoiceImport(prior);return {changed:false,invoiceCount:parsed.groups.size};}
 const next=prior?reconcile(prior,parsed):incoming;
 const cleanManifest={...manifest};delete cleanManifest.rawCsv;
 next.last_ingest=manifest.importedAt;next.dashboardManifest=cleanManifest;
 fs.mkdirSync(dir,{recursive:true});if(fs.existsSync(file))fs.copyFileSync(file,path.join(dir,'lines.previous.json'));
 fs.mkdirSync(path.join(dir,'raw'),{recursive:true});fs.writeFileSync(path.join(dir,'raw',hash+'.csv'),manifest.rawCsv);
 atomic(file,next);atomic(path.join(dir,'import-manifest.json'),cleanManifest);
 recordInvoiceImport(next);
 return {changed:true,invoiceCount:parsed.groups.size,lineCount:next.lines.length};
}
export async function handleDashboard(req,res){
 const route=new URL(req.url,'http://localhost').pathname;if(!route.startsWith('/dashboard/'))return false;
 const respond=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'private, no-store'});res.end(JSON.stringify(value));};
 const reading=req.method==='GET'&&route==='/dashboard/snapshots';
 if(!authorized(req.headers.authorization,process.env[reading?'DASHBOARD_READ_KEY':'DASHBOARD_IMPORT_KEY'])){respond(401,{error:'Unauthorized'});return true;}
 try{
  if(reading){respond(200,snapshots());return true;}
  if(req.method==='POST'&&route==='/dashboard/activity/cleanup'){respond(200,{ok:true,changed:ingestCleanup(await body(req))});return true;}
  if(req.method==='POST'&&route==='/dashboard/import'){const result=importInvoices(await body(req));respond(200,result);if(result.changed)requestPrimeRefresh();return true;}
  if(req.method==='POST'&&route==='/dashboard/snapshots'){
   const payload=await body(req);if(!payload?.snapshots||Array.isArray(payload.snapshots)||typeof payload.snapshots!=='object')throw Error('Invalid snapshots');
   for(const [source,value] of Object.entries(payload.snapshots))validateSnapshot(source,value);
   const changed=[];for(const [source,value] of Object.entries(payload.snapshots))if(saveSnapshot(source,value))changed.push(source);
   respond(200,{ok:true,changed});return true;
  }
  respond(404,{error:'Not found'});
 }catch{respond(400,{error:'Invalid or stale payload; existing data retained'});}
 return true;
}
