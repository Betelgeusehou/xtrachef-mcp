// Read-only response shape and aggregate numbers; never requests subscriptions.
const key=process.env.BEEHIIV_API_KEY;
if(!key){console.log(JSON.stringify({ok:false,reason:'missing_beehiiv_key'}));process.exit(1);}
const base='https://api.beehiiv.com/v2/publications/pub_fcd4a61d-3672-4d96-a6fc-7ae8943b3a51';
function shape(value,depth=0){if(value===null)return 'null';if(Array.isArray(value))return {type:'array',length:value.length,item:value.length?shape(value[0],depth+1):null};if(typeof value!=='object')return typeof value;if(depth>5)return 'object';return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,shape(v,depth+1)]));}
function numeric(value){return value&&typeof value==='object'?Object.fromEntries(Object.entries(value).filter(([,v])=>typeof v==='number'&&Number.isFinite(v))):{};}
for(const [name,suffix]of [['publication','?expand%5B%5D=stats'],['aggregate','/posts/aggregate_stats']]){
 try{const r=await fetch(base+suffix,{headers:{Authorization:'Bearer '+key},signal:AbortSignal.timeout(45000)});if(!r.ok){console.log(JSON.stringify({source:name,ok:false,httpStatus:r.status}));process.exitCode=1;continue;}const payload=await r.json();const output={source:name,ok:true,shape:shape(payload),aggregateNumbers:name==='publication'?numeric(payload.data?.stats):numeric(payload.data?.stats?.email),computedAt:Number.isFinite(payload.data?.computed_at)?payload.data.computed_at:null};console.log(JSON.stringify(output).split(key).join('[REDACTED]'));}
 catch{console.log(JSON.stringify({source:name,ok:false,reason:'probe_failed'}));process.exitCode=1;}
}
