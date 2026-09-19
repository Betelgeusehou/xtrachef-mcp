export const storeNames=['Montrose','Washington'];
export function localParts(value){const date=new Date(value);if(!Number.isFinite(date.getTime()))throw Error('Invalid order timestamp');return Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'America/Chicago',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(date).map(p=>[p.type,p.value]));}
export function shiftDate(iso,days){const d=new Date(iso+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10);}
export function businessClock(now=new Date().toISOString()){const p=localParts(now),calendarDate=`${p.year}-${p.month}-${p.day}`,hour=Number(p.hour),minute=hour*60+Number(p.minute);return {businessDate:hour<4?shiftDate(calendarDate,-1):calendarDate,minute:minute+(hour<4?1440:0)};}
export function baselineDates(date){return [7,14,21,28].map(days=>shiftDate(date,-days));}
export function service(name,date,minute){const day=new Date(date+'T12:00:00Z').getUTCDay();const open=name==='Montrose'?(day===0||day===6?720:960):(day===0||day===5||day===6?720:960);const close=name==='Montrose'?1440:1560;return {open,close,state:minute<open?'upcoming':minute<close?'open':'closed'};}
export function aggregateOrders(orders,businessDate,asOf){const unique=new Map();for(const order of orders){if(!order.guid)throw Error('Order identity missing');const old=unique.get(order.guid);if(!old||Date.parse(order.modifiedDate||order.openedDate)>=Date.parse(old.modifiedDate||old.openedDate))unique.set(order.guid,order);}
 const minutes=[];for(const o of unique.values()){if(o.voided||o.deleted||o.createdInTestMode)continue;if(String(o.businessDate)!==businessDate.replaceAll('-',''))throw Error('Unexpected order business date');if(Date.parse(o.openedDate)>Date.parse(asOf))continue;const p=localParts(o.openedDate),calendarDate=`${p.year}-${p.month}-${p.day}`;if(calendarDate!==businessDate&&calendarDate!==shiftDate(businessDate,1))throw Error('Order date outside business day');const minute=Number(p.hour)*60+Number(p.minute)+(calendarDate===businessDate?0:1440);if(minute>1680)throw Error('Order after business closeout');minutes.push(minute);}
 return minutes.sort((a,b)=>a-b);
}
export const countAt=(minutes,cutoff)=>minutes.filter(m=>m<=cutoff).length;
const cents=value=>{if(typeof value!=='number'||!Number.isFinite(value))throw Error('Missing sales amount');return Math.round(value*100);};
export function orderNetCents(order){
 if(order.voided||order.deleted||order.createdInTestMode||order.excessFood)return 0;
 if(!Array.isArray(order.checks))throw Error('Order checks missing');
 return order.checks.reduce((total,check)=>{
  if(check.voided||check.deleted)return total;
  let net=cents(check.amount);
  for(const selection of check.selections||[])if(!selection.voided&&(selection.deferred||selection.selectionType==='HOUSE_ACCOUNT_PAY_BALANCE'))net-=cents(selection.price);
  for(const charge of check.appliedServiceCharges||[])if(charge.serviceChargeCategory==='FUNDRAISING_CAMPAIGN')net-=cents(charge.chargeAmount);
  for(const payment of check.payments||[])if(payment.refund)net-=cents(payment.refund.refundAmount);
  return total+net;
 },0);
}
export function aggregateSales(orders,businessDate,asOf){
 const unique=new Map();for(const order of orders){if(!order.guid)throw Error('Order identity missing');const old=unique.get(order.guid);if(!old||Date.parse(order.modifiedDate||order.openedDate)>=Date.parse(old.modifiedDate||old.openedDate))unique.set(order.guid,order);}
 return [...unique.values()].flatMap(order=>{const minutes=aggregateOrders([order],businessDate,asOf);return minutes.length?[{minute:minutes[0],netCents:orderNetCents(order)}]:[];}).sort((a,b)=>a.minute-b.minute);
}
export const salesAt=(sales,cutoff)=>Array.isArray(sales)?sales.filter(s=>s.minute<=cutoff).reduce((total,s)=>total+s.netCents,0)/100:null;
export function buildStore({name,now,actual,baselines,previous,error=false}){const clock=businessClock(now),dates=baselineDates(clock.businessDate);if(!actual){if(previous&&previous.businessDate===clock.businessDate)return {...previous,state:'error',lastAttemptAt:now,error:'Latest order read failed; saved values shown.'};return {name,...clock,service:service(name,clock.businessDate,clock.minute),state:'error',lastAttemptAt:now,dataAsOf:null,actual:null,baseline:null,delta:null,baselineDays:[],chart:[]};}
 const cutoff=businessClock(actual.fetchedAt).minute;if(actual.date!==clock.businessDate)throw Error('Wrong actual date');
 const days=dates.map(date=>{const source=baselines.find(d=>d.date===date);return {date,complete:!!source,fetchedAt:source?.fetchedAt||null,count:source?countAt(source.minutes,cutoff):null};});
 const complete=days.every(d=>d.complete),baseline=complete?days.reduce((n,d)=>n+d.count,0)/4:null,current=countAt(actual.minutes,cutoff);
 const chart=Array.from({length:49},(_,i)=>720+i*20).filter(m=>m<=cutoff).map(minute=>({minute,actual:countAt(actual.minutes,minute),baseline:complete?baselines.reduce((n,d)=>n+countAt(d.minutes,minute),0)/4:null}));
 const netSales=salesAt(actual.sales,cutoff),salesComplete=complete&&baselines.every(d=>Array.isArray(d.sales)),baselineNetSales=salesComplete?baselines.reduce((n,d)=>n+salesAt(d.sales,cutoff),0)/4:null;
 return {name,businessDate:clock.businessDate,minute:cutoff,service:service(name,clock.businessDate,cutoff),state:error?'partial':'ready',lastAttemptAt:now,dataAsOf:actual.fetchedAt,actual:current,baseline,delta:baseline&&baseline>0?(current/baseline-1)*100:null,netSales,baselineNetSales,salesDelta:netSales!==null&&baselineNetSales>0?(netSales/baselineNetSales-1)*100:null,baselineDays:days,chart};
}
