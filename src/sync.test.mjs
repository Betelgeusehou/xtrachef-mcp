import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xc-sync-'));
process.env.XTRACHEF_DATA_DIR=dir;process.env.DASHBOARD_DATA_DIR=path.join(dir,'dashboard');
const store=await import('./store.js');const sync=await import('./sync.js');
const H=['Tenant Name','Location Name','Vendor Name','Invoice Number','Upload Date','Invoice Date','Invoice Total','Type','Line Product Item Number','Line Description','Line Category','Line GL Code','Line GL Description','Line Quantity','Line Unit Price','Line Size','Line Pack','Line UOM','Size UOM','Line Total','Status','Invoice Sales Tax','Invoice Other Charges','Invoice Freight Charges','Invoice Discounts','Invoice Returns and Credits'];
const r=(inv,desc,total,up='09/20/2026')=>['T','Washington - Betelgeuse Betelgeuse','Keg Co',inv,up,'09/19/2026',total,'Invoice','K1',desc,'Beer','Cost - Beer','Cost - Beer',1,50,'','1','ke','',50,'Completed',0,0,0,0,0];
const csv=rows=>[H,...rows].map(x=>x.join(',')).join('\n');
test('invoice-level replace keeps repeated lines, is idempotent, and overwrites bad copies',()=>{
 store.replaceStore({lines:[{location:'Washington - Betelgeuse Betelgeuse',vendor:'Keg Co',invoice_number:'A1',doc_type:'Invoice',description:'TYPO',line_total:999}]});
 const text=csv([r('A1','KEG DEPOSIT',100),r('A1','KEG DEPOSIT',100)]);
 let res=store.replaceInvoicesFromCsv(text,'n1.csv');assert.equal(res.removed,1);assert.equal(res.added,2);
 res=store.replaceInvoicesFromCsv(text,'n2.csv');assert.equal(res.removed,2);
 const lines=store.loadStore().lines;assert.equal(lines.length,2);assert.equal(lines.reduce((s,l)=>s+l.line_total,0),100);
 assert.equal(store.newestDates().upload_date,'2026-09-20');
});
test('health flags stale uploads and disabled sync',()=>{
 delete process.env.XTRACHEF_SYNC_ENABLED;
 const h=sync.health(new Date('2026-09-23T15:00:00Z'));assert.equal(h.state,'ALERT');
 assert.ok(h.problems.some(p=>/3 days/.test(p)));assert.ok(h.problems.some(p=>/off/.test(p)));
 process.env.XTRACHEF_SYNC_ENABLED='true';
 assert.equal(sync.health(new Date('2026-09-21T15:00:00Z')).state,'ok');
});
test('real export: dashboard parser and MCP replace agree on totals',async()=>{
 const f='/mnt/user-data/uploads/Downloads/Invoices_Betelgeuse_Betelgeuse_09232026_062749.csv';if(!fs.existsSync(f))return;
 const text=fs.readFileSync(f,'utf8');const {readExport}=await import('../dashboard/invoice-import.mjs');
 const p=readExport(text);store.replaceStore({lines:[]});const res=store.replaceInvoicesFromCsv(text,'real.csv');
 assert.equal(res.invoices,p.groups.size);assert.equal(res.lines,p.lines.length);
});
import http from 'node:http';
test('drive sync: loads newest export once, skips the same file, dashboard gets it too',async()=>{
 const f='/mnt/user-data/uploads/Downloads/Invoices_Betelgeuse_Betelgeuse_09232026_062749.csv';if(!fs.existsSync(f))return;
 const body=fs.readFileSync(f);const srv=http.createServer((q,r)=>{r.end(body)});await new Promise(r=>srv.listen(0,'127.0.0.1',r));
 const url='http://127.0.0.1:'+srv.address().port+'/x';
 process.env.COMPOSIO_CONSUMER_API_KEY='test';process.env.DASHBOARD_ENABLED='true';process.env.XTRACHEF_SYNC_ENABLED='true';
 let calls=[];const connect=async()=>({close:async()=>{},callTool:async({arguments:a})=>{const t=a.tools[0];calls.push(t.tool_slug);
  const data=t.tool_slug==='GOOGLEDRIVE_FIND_FILE'?{files:[{id:'F1',name:'Invoices_Betelgeuse_Betelgeuse_09232026_062749.csv',md5Checksum:'m1',createdTime:'2026-09-23T12:09:11Z'},{id:'X',name:'notes.txt'}]}:{downloaded_file_content:{s3url:url}};
  return {content:[{type:'text',text:JSON.stringify({data:{results:[{tool_slug:t.tool_slug,response:{successful:true,data}}]}})}]};}});
 try{
  store.replaceStore({lines:[]});
  const r1=await sync.syncNow({connect});assert.equal(r1.ok,true,JSON.stringify(r1));assert.equal(r1.new_file,true);assert.equal(r1.invoices,562);assert.equal(r1.dashboard.changed,true);
  const r2=await sync.syncNow({connect});assert.equal(r2.new_file,false);
  assert.deepEqual(calls,['GOOGLEDRIVE_FIND_FILE','GOOGLEDRIVE_DOWNLOAD_FILE','GOOGLEDRIVE_FIND_FILE']);
  const h=sync.health(new Date('2026-09-23T15:00:00Z'));assert.equal(h.state,'ok',JSON.stringify(h.problems));assert.equal(h.newest_invoice_date>='2026-09-22',true);
  const failing=async()=>({close:async()=>{},callTool:async()=>({content:[{type:'text',text:JSON.stringify({data:{results:[{tool_slug:'GOOGLEDRIVE_FIND_FILE',response:{successful:false,error:'403'}}]}})}]})});
  const r3=await sync.syncNow({connect:failing});assert.equal(r3.ok,false);assert.equal(sync.health().state,'ALERT');
 }finally{srv.close();}
});
test.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
