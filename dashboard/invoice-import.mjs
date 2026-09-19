import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const columns={'Location Name':'location','Vendor Name':'vendor','Invoice Number':'invoice_number','Upload Date':'upload_date','Invoice Date':'invoice_date','Invoice Total':'invoice_total','Type':'doc_type','Line Product Item Number':'item_code','Line Description':'description','Line Category':'category','Line GL Code':'gl_code','Line GL Description':'gl_description','Line Quantity':'quantity','Line Unit Price':'unit_price','Line Size':'size','Line Pack':'pack','Line UOM':'uom','Size UOM':'size_uom','Line Total':'line_total','Status':'status'};
const numeric=new Set(['invoice_total','quantity','unit_price','line_total']);
export const invoiceKey=l=>JSON.stringify([l.location,l.vendor,l.invoice_number,l.doc_type]);
export function parseCsv(text){
 const rows=[];let row=[],field='',quoted=false;
 for(let i=0;i<text.length;i++){const c=text[i];if(quoted){if(c==='"'){if(text[i+1]==='"'){field+='"';i++;}else quoted=false;}else field+=c;}else if(c==='"'){if(field)throw Error('Malformed CSV');quoted=true;}else if(c===','){row.push(field);field='';}else if(c==='\r'||c==='\n'){if(c==='\r'&&text[i+1]==='\n')i++;row.push(field);if(row.some(x=>x!==''))rows.push(row);row=[];field='';}else field+=c;}
 if(quoted)throw Error('Incomplete CSV');if(field||row.length){row.push(field);rows.push(row);}return rows;
}
function date(v){const m=/^(\d{2})\/(\d{2})\/(\d{4})$/.exec(v);if(!m)throw Error('Invalid invoice date');const iso=`${m[3]}-${m[1]}-${m[2]}`;if(new Date(iso+'T12:00:00Z').toISOString().slice(0,10)!==iso)throw Error('Invalid invoice date');return iso;}
export function readExport(text){
 const rows=parseCsv(text.replace(/^\uFEFF/,''));const headers=rows.shift()?.map(x=>x.trim())||[];
 const adjustments=['Invoice Sales Tax','Invoice Other Charges','Invoice Freight Charges','Invoice Discounts','Invoice Returns and Credits'];
 for(const col of [...Object.keys(columns),...adjustments])if(!headers.includes(col))throw Error('Incomplete line-item export');
 if(!rows.length)throw Error('Empty export');const groups=new Map(),totals=new Map();
 for(const row of rows){if(row.length!==headers.length)throw Error('Incomplete CSV row');const l={};for(const [col,key]of Object.entries(columns)){const v=row[headers.indexOf(col)].trim();l[key]=numeric.has(key)?(v===''?null:Number(v)):key.endsWith('_date')?date(v):v;if(numeric.has(key)&&l[key]!==null&&!Number.isFinite(l[key]))throw Error('Invalid invoice amount');}
  if(!['Montrose - Betelgeuse Betelgeuse','Washington - Betelgeuse Betelgeuse'].includes(l.location)||!l.vendor||!l.invoice_number||l.line_total===null||l.invoice_total===null||l.status!=='Completed')throw Error('Unexpected invoice identity or status');
  const key=invoiceKey(l),group=groups.get(key)||[];if(group.length&&(group[0].invoice_total!==l.invoice_total||group[0].invoice_date!==l.invoice_date))throw Error('Inconsistent invoice group');l.source_line_id=key+':'+group.length;group.push(l);groups.set(key,group);
  const values=adjustments.map(c=>Number(row[headers.indexOf(c)]));if(values.some(v=>!Number.isFinite(v)))throw Error('Invalid invoice adjustment');
  const adjustment=values[0]+values[1]+values[2]-values[3]-values[4];if(totals.has(key)&&totals.get(key)!==adjustment)throw Error('Inconsistent invoice adjustment');totals.set(key,adjustment);
 }
 for(const [key,lines]of groups)if(Math.abs(lines.reduce((sum,l)=>sum+l.line_total,0)+totals.get(key)-lines[0].invoice_total)>0.03)throw Error('Invoice lines do not reconcile to total');
 return {groups,lines:[...groups.values()].flat()};
}
export function reconcile(store,parsed){
 if(!store||!Array.isArray(store.lines))throw Error('Invalid prior invoice store');
 // Every represented invoice is replaced as a whole. Identical legitimate rows survive.
 const lines=store.lines.filter(l=>!parsed.groups.has(invoiceKey(l))).concat(parsed.lines);
 return {...store,lines};
}
const atomic=(file,data)=>{fs.writeFileSync(file+'.tmp',JSON.stringify(data));fs.renameSync(file+'.tmp',file);};
export function importLatest({downloads,dataDir,seedFile,expectedInvoices}){
 fs.mkdirSync(dataDir,{recursive:true});const target=path.join(dataDir,'lines.json'),manifestPath=path.join(dataDir,'import-manifest.json');
 const files=fs.readdirSync(downloads).filter(n=>/^Invoices_Betelgeuse_Betelgeuse_\d{8}_\d{6}\.csv$/i.test(n)).map(name=>({name,full:path.join(downloads,name),stat:fs.statSync(path.join(downloads,name))})).filter(f=>Date.now()-f.stat.mtimeMs>5000).sort((a,b)=>b.stat.mtimeMs-a.stat.mtimeMs);
 if(!files.length)throw Error('No completed invoice export');const file=files[0];const text=fs.readFileSync(file.full,'utf8'),hash=crypto.createHash('sha256').update(text).digest('hex');
 const prior=fs.existsSync(manifestPath)?JSON.parse(fs.readFileSync(manifestPath,'utf8')):null;
 if(prior?.schemaVersion===2&&prior?.sha256===hash&&fs.existsSync(target))return {...prior,checkedAt:new Date().toISOString()};
 if(prior&&file.stat.mtimeMs+1<Date.parse(prior.exportFileAt))throw Error('Older invoice export cannot replace newer data');
 // Only the export workflow can approve a new file after checking the visible UI count.
 if(!Number.isInteger(expectedInvoices)||expectedInvoices<1){if(prior&&fs.existsSync(target))return {...prior,checkedAt:new Date().toISOString(),pendingExport:true};throw Error('Export requires verified completed-invoice count');}
 const parsed=readExport(text);if(parsed.groups.size!==expectedInvoices)throw Error('Export count differs from visible completed count');
 const store=JSON.parse(fs.readFileSync(fs.existsSync(target)?target:seedFile,'utf8'));
 const next=reconcile(store,parsed),at=new Date().toISOString();
 const info={schemaVersion:2,source:file.name,sha256:hash,exportFileAt:file.stat.mtime.toISOString(),importedAt:at,checkedAt:at,invoiceCount:parsed.groups.size,lineCount:parsed.lines.length,latestInvoiceDate:parsed.lines.map(l=>l.invoice_date).sort().at(-1),latestUploadDate:parsed.lines.map(l=>l.upload_date).sort().at(-1),mode:'local-export-watch'};
 next.last_ingest=at;next.ingested_files={...next.ingested_files,[file.name]:{at,sha256:hash,invoices:parsed.groups.size,lines:parsed.lines.length}};
 if(fs.existsSync(target))fs.copyFileSync(target,path.join(dataDir,'lines.previous.json'));
 fs.mkdirSync(path.join(dataDir,'raw'),{recursive:true});fs.copyFileSync(file.full,path.join(dataDir,'raw',hash+'.csv'));
 atomic(target,next);atomic(manifestPath,info);return info;
}
