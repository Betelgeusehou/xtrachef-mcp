import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import zlib from 'node:zlib';import http from 'node:http';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xc-pmix-'));
process.env.XTRACHEF_DATA_DIR=dir;process.env.DASHBOARD_DATA_DIR=path.join(dir,'dashboard');
const pmix=await import('./pmix.js');

// Tiny zip writer so tests can build .xlsx files shaped like xtraCHEF's export.
function zip(files){const parts=[],cd=[];let off=0;
 for(const [name,text] of Object.entries(files)){const raw=Buffer.from(text),data=zlib.deflateRawSync(raw),n=Buffer.from(name);
  const lh=Buffer.alloc(30);lh.writeUInt32LE(0x04034b50,0);lh.writeUInt16LE(8,8);lh.writeUInt32LE(data.length,18);lh.writeUInt32LE(raw.length,22);lh.writeUInt16LE(n.length,26);
  const ch=Buffer.alloc(46);ch.writeUInt32LE(0x02014b50,0);ch.writeUInt16LE(8,10);ch.writeUInt32LE(data.length,20);ch.writeUInt32LE(raw.length,24);ch.writeUInt16LE(n.length,28);ch.writeUInt32LE(off,42);
  parts.push(lh,n,data);cd.push(ch,n);off+=30+n.length+data.length;}
 const cdb=Buffer.concat(cd),e=Buffer.alloc(22);e.writeUInt32LE(0x06054b50,0);e.writeUInt16LE(cd.length/2,8);e.writeUInt16LE(cd.length/2,10);e.writeUInt32LE(cdb.length,12);e.writeUInt32LE(off,16);
 return Buffer.concat([...parts,cdb,e]);}
const s=(r,v)=>`<c r="${r}" t="str"><v>${v}</v></c>`,n=(r,v)=>`<c r="${r}"><v>${v}</v></c>`;
function xlsx(loc,from,to,items){
 const rows=[`<row r="1">${s('A1','Location: '+loc+' ')}${s('C1','Product Mix Report By Item - Summary')}</row>`,`<row r="2">${s('C2',`Report  from ${from} to ${to}`)}</row>`,
  `<row r="4">${['Name','Avg. Menu Price','Qty Sold','Gross Amount','Discount','Net Sales','Net Menu Price','Gross Margin','Net Margin','Prime Cost','Total Cost'].map((h,i)=>s(String.fromCharCode(65+i)+'4',h)).join('')}</row>`,
  ...items.map(([nm,q,net,cost],i)=>{const r=i+5;return `<row r="${r}">${s('A'+r,nm)}${n('C'+r,q)}${n('F'+r,net)}${n('K'+r,cost)}</row>`;})];
 return zip({'xl/workbook.xml':'<workbook/>','xl/worksheets/sheet1.xml':`<worksheet><sheetData>${rows.join('')}</sheetData></worksheet>`});}

test('parses an xtraCHEF summary export: location, period, items, escapes, skips totals',()=>{
 const p=pmix.parseProductMix(xlsx('Washington - Betelgeuse Betelgeuse','10/01/2026','10/26/2026',[['Mac &amp; Cheese',3,30.005,6.444],['',1,1,1],['Total',9,99,9]]));
 assert.equal(p.location,'Washington - Betelgeuse Betelgeuse');assert.equal(p.first,'2026-10-01');assert.equal(p.last,'2026-10-26');
 assert.deepEqual(p.items,[['Mac & Cheese',3,30.01,6.44]]);
});
test('real exports parse the same as openpyxl did (when samples are present)',()=>{
 const d=process.env.PMIX_SAMPLE_DIR;if(!d||!fs.existsSync(path.join(d,'wash.xlsx')))return;
 const w=pmix.parseProductMix(fs.readFileSync(path.join(d,'wash.xlsx'))),m=pmix.parseProductMix(fs.readFileSync(path.join(d,'mont.xlsx')));
 assert.equal(w.items.length,249);assert.equal(m.items.length,215);assert.equal(w.last,'2026-10-26');
 assert.equal(Math.round(w.items.reduce((t,i)=>t+i[2],0)),265909);assert.equal(Math.round(m.items.reduce((t,i)=>t+i[2],0)),93319);
});
test('drive load: picks the newest file per store, loads once, skips the same pair, reports failures',async()=>{
 const bodies={W1:xlsx('Washington - Betelgeuse Betelgeuse','10/01/2026','10/25/2026',[['Old',1,1,1]]),
  W2:xlsx('Washington - Betelgeuse Betelgeuse','10/01/2026','10/26/2026',[['Pepperoni',10,200,40]]),
  M2:xlsx('Montrose - Betelgeuse Betelgeuse(Central Kitchen)','10/01/2026','10/26/2026',[['Wings',5,100,25],['Tenders',2,20,8]])};
 const srv=http.createServer((q,r)=>r.end(bodies[q.url.slice(1)]));await new Promise(r=>srv.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+srv.address().port+'/';
 process.env.COMPOSIO_CONSUMER_API_KEY='test';
 const calls=[];const connect=async()=>({close:async()=>{},callTool:async({arguments:a})=>{const t=a.tools[0];calls.push(t.tool_slug+(t.arguments.fileId?':'+t.arguments.fileId:''));
  assert.equal(t.arguments.folder_id??'1vw685QiL23v_pXvcerglrmMGdILOwV5v','1vw685QiL23v_pXvcerglrmMGdILOwV5v');
  const data=t.tool_slug==='GOOGLEDRIVE_FIND_FILE'?{files:[
   {id:'W1',name:'Washington - Betelgeuse Betelgeuse _PmixByItem_Summary_20261026_053600.xlsx',md5Checksum:'a',createdTime:'2026-10-27T11:00:00Z'},
   {id:'M2',name:'Montrose - Betelgeuse Betelgeuse(Central Kitchen) _PmixByItem_Summary_20261027_053629.xlsx',md5Checksum:'b'},
   {id:'W2',name:'Washington - Betelgeuse Betelgeuse _PmixByItem_Summary_20261027_053600.xlsx',md5Checksum:'c'},
   {id:'X',name:'Invoices_Betelgeuse_Betelgeuse_10272026_050535.csv'}]}:{downloaded_file_content:{s3url:base+t.arguments.fileId}};
  return {content:[{type:'text',text:JSON.stringify({data:{results:[{tool_slug:t.tool_slug,response:{successful:true,data}}]}})}]};}});
 try{
  const r1=await pmix.loadNow({connect});assert.equal(r1.ok,true,JSON.stringify(r1));assert.equal(r1.new_files,true);
  assert.deepEqual(calls,['GOOGLEDRIVE_FIND_FILE','GOOGLEDRIVE_DOWNLOAD_FILE:W2','GOOGLEDRIVE_DOWNLOAD_FILE:M2']);
  const c=pmix.current(new Date('2026-10-27T15:00:00Z'));assert.equal(c.state,'ok',JSON.stringify(c.problems));
  assert.equal(c.first,'2026-10-01');assert.equal(c.last,'2026-10-26');assert.deepEqual(c.wash,[['Pepperoni',10,200,40]]);assert.equal(c.mont.length,2);
  const r2=await pmix.loadNow({connect});assert.equal(r2.new_files,false);
  assert.equal(pmix.current(new Date('2026-10-29T15:00:00Z')).state,'ALERT');
  const failing=async()=>({close:async()=>{},callTool:async()=>({content:[{type:'text',text:JSON.stringify({data:{results:[{tool_slug:'GOOGLEDRIVE_FIND_FILE',response:{successful:false,error:'403'}}]}})}]})});
  const r3=await pmix.loadNow({connect:failing});assert.equal(r3.ok,false);
  const c3=pmix.current(new Date('2026-10-27T15:00:00Z'));assert.equal(c3.state,'ALERT');assert.equal(c3.wash.length,1,'keeps last good data after a failed load');
 }finally{srv.close();}
});
test.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
