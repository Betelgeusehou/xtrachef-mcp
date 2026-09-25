export const classifierVersion='2026-09-25-categories-v1';
const food = new Set(['Dairy','Protein','Paper - Food Costs','Frozen Goods','Dry Goods','Cooking Oil','Produce','Bread','Oils, Vinegars','Dressings','Spices']);
const bar = new Set(['Liquor','Beer','Wine','Mixer','Bar Produce','Cost - Liquor:Cost - Liquor','Cost - Liquor:Cost - Bar Produce','Drink Presentation (Garnishes)']);
const nonPrime = new Set(['Utilities','Restaurant Supply','Administrative Expense','Non Controllable Expenses:Equipment Lease:Rental Equipment','Repairs and Maintenance','Kitchen Supply','Cleaning Supplies','Controllable Expenses:Employee Benefits','Operations','Controllable Expenses:Direct Operating Expenses:Supplies - Paper','Controllable Expenses:Direct Operating Expenses:Kitchen Utencils','Phone-Internet','Bar Supply','Controllable Expenses:Administrative & General:Internet Subscription']);
export const stores = ['Montrose','Washington'];
export function auditWages(employees,entries,from,through){
 const names=new Map(employees.map(e=>[e.guid,`${e.firstName} ${e.lastName}`.toLowerCase().trim()]));
 const ownerNames=new Set(['chris cusack','grace burke']);
 if(![...names.values()].some(n=>n==='chris cusack')||![...names.values()].some(n=>n==='grace burke'))throw new Error('Owner identities unavailable');
 const pureSalary=new Set(['jason benfield','jason benefield','jared harvey']);
 const byDay={},seen=new Set();let missingWageEntries=0,managerOverlap=0,ownerExcluded=0;
 for(const e of entries){
  if(e.businessDate<Number(from.replaceAll('-',''))||e.businessDate>Number(through.replaceAll('-','')))continue;
  if(seen.has(e.guid))throw new Error('Duplicate time entry');seen.add(e.guid);
  if(!names.has(e.employeeGuid))throw new Error('Unmapped wage identity');
  const amount=(e.regularHours||0)*(e.hourlyWage||0)+(e.overtimeHours||0)*(e.hourlyWage||0)*1.5;
  if(!Number.isFinite(amount))throw new Error('Invalid wage entry');
  if(e.hourlyWage==null&&((e.regularHours||0)+(e.overtimeHours||0)>0))missingWageEntries++;
  const name=names.get(e.employeeGuid),owner=ownerNames.has(name);
  if(pureSalary.has(name)&&amount>0)managerOverlap+=amount;
  const d=byDay[e.businessDate]||={total:0,owner:0};d.total+=amount;if(owner){d.owner+=amount;ownerExcluded+=amount;}
 }
 return {byDay,missingWageEntries,managerOverlap,ownerExcluded};
}
export function businessPeriod(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'America/Chicago',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23'}).formatToParts(now).map(p=>[p.type,p.value]));
  // Prime cost uses completed business days; at 4 AM yesterday becomes complete.
  const day = new Date(`${parts.year}-${parts.month}-${parts.day}T12:00:00Z`);
  day.setUTCDate(day.getUTCDate() - (Number(parts.hour)<4 ? 2 : 1));
  const through=day.toISOString().slice(0,10), from=through.slice(0,7)+'-01';
  return {from,through};
}
export function dateRange(from,through) {
 const dates=[]; for(let d=new Date(from+'T12:00:00Z');d.toISOString().slice(0,10)<=through;d.setUTCDate(d.getUTCDate()+1))dates.push(d.toISOString().slice(0,10));
 return dates;
}
export function classify(line) {
 if(!stores.some(s=>line.location===`${s} - Betelgeuse Betelgeuse`))return 'review';
 if(/^inventory_seed$/i.test(line.category||'') || /^Betelgeuse Betelgeuse$/i.test(line.vendor||''))return 'excluded';
 if(line.status!=='Completed'||!['Invoice','Receipt'].includes(line.doc_type))return 'review';
 const c=line.category,d=line.description||'';
 if(c==='Keg Deposits'||/^EMPTY-(MICROSTAR|LONE PINT|KEG LOGISTICS)\b/i.test(d)||/^1\/2 Keg Shell (Deposit|Credit)$/i.test(d))return 'deposits';
 if(/shell (credit|return|deposit)|^empty-/i.test(d))return 'review';
 if(food.has(c))return 'food';if(bar.has(c))return 'bar';if(c==='NA Bev')return 'na';
 return nonPrime.has(c)?'excluded':'review';
}
export function makeSnapshot({from,through,invoices,status,records,rates,salaryBaseline,now=new Date().toISOString(),refresh={}}) {
 const dates=dateRange(from,through), keys=new Set();
 for(const r of records){
  const date=String(r.businessDate), iso=`${date.slice(0,4)}-${date.slice(4,6)}-${date.slice(6,8)}`;
  const key=[r.restaurantGuid,r.businessDate,r.type].join(':');
  if(!stores.includes(r.restaurantGuid)||!dates.includes(iso)||!['sales','labor'].includes(r.type)||keys.has(key)||r.error||r.data?.businessDate!==r.businessDate)throw new Error('Incomplete or inconsistent Toast coverage');
  const amount=r.type==='sales'?r.data.netSales:r.data.totalWages;
  if(!Number.isFinite(amount))throw new Error('Invalid Toast amount');keys.add(key);
 }
 if(keys.size!==dates.length*4)throw new Error('Missing Toast days');
 let salaryBiweekly;
 if(salaryBaseline){
  const b=salaryBaseline;
  if(!b.excludesOwnerComp||![b.biweeklyCents,b.salaryBeforeOwnerCents,b.ownerExcludedCents].every(n=>Number.isSafeInteger(n)&&n>=0)||b.salaryBeforeOwnerCents-b.ownerExcludedCents!==b.biweeklyCents||dateRange(b.periodStart,b.periodEnd).length!==14)throw new Error('Invalid payroll baseline');
  salaryBiweekly=b.biweeklyCents/100;
 }else{
  if(!rates||rates.length!==2||new Set(rates.map(r=>r.restaurant_id)).size!==2||rates.some(r=>![3,4].includes(r.restaurant_id)||!r.excludes_owner_comp||!Number.isFinite(r.biweekly_cents)||r.biweekly_cents<0))throw new Error('Invalid salary configuration');
  salaryBiweekly=rates.reduce((s,r)=>s+r.biweekly_cents/100,0);
 }
 const days=dates.map(date=>({date,food:0,bar:0,na:0,excluded:0,review:0,deposits:0,sales:0,wages:0,salaries:salaryBiweekly/14}));
 const groups={food:0,bar:0,na:0,excluded:0,review:0,deposits:0};let undatedLines=0;const seen=new Set();
 for(const line of invoices){
  if(!Number.isFinite(line.line_total))throw new Error('Invalid invoice amount');
  if(!line.invoice_date){undatedLines++;continue;}
  const day=days.find(d=>d.date===line.invoice_date);if(!day)continue;
  const identity=line.source_line_id||JSON.stringify([line.location,line.vendor,line.invoice_number,line.item_code,line.description,line.quantity,line.unit_price,line.line_total]);
  if(seen.has(identity))throw new Error('Duplicate invoice line');seen.add(identity);
  const bucket=classify(line);day[bucket]+=line.line_total;groups[bucket]+=line.line_total;
 }
 for(const day of days)for(const r of records.filter(r=>r.businessDate===Number(day.date.replaceAll('-',''))))day[r.type==='sales'?'sales':'wages']+=r.type==='sales'?r.data.netSales:r.data.totalWages;
 return {classifierVersion,generatedAt:now,invoiceIngestAt:status.last_ingest,latestInvoiceDate:status.invoice_date_range.to,toastFetchedAt:now,from,through,salaryBasis:salaryBaseline?.basis||'Configured PrimeCost run-rates from July 6–19 payroll; current rates need verification',salaryBiweekly,groups,days,undatedLines,refresh};
}
