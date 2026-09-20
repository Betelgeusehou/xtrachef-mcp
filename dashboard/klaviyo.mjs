import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {inRefreshWindow} from './refresh-schedule.mjs';
const account='klaviyo_vert-palp',metric='WPjgdi';
const fields=['recipients','delivered','opens_unique','clicks_unique','bounced','spam_complaints','unsubscribe_uniques'];
export function reportWindow(now){
 const day=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Chicago',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
 const shift=(d,n)=>{const date=new Date(d+'T12:00:00Z');date.setUTCDate(date.getUTCDate()+n);return date.toISOString().slice(0,10);};
 const midnight=d=>{const offset=new Intl.DateTimeFormat('en',{timeZone:'America/Chicago',timeZoneName:'longOffset'}).formatToParts(new Date(d+'T06:00:00Z')).find(p=>p.type==='timeZoneName').value.replace('GMT','');return d+'T00:00:00'+offset;};
 const from=shift(day,-28);return {from,through:shift(day,-1),start:midnight(from),end:midnight(day),timezone:'America/Chicago'};
}
export function executionResult(result,slug){
 if(result?.isError)throw Error('Composio request failed');
 const payload=result.structuredContent??JSON.parse(result.content.find(c=>c.type==='text').text);
 if(payload.successful===false||payload.error)throw Error('Composio operation failed');
 const results=payload.data?.results??payload.results;
 if(!Array.isArray(results)||results.length!==1||results[0].tool_slug!==slug||results[0].response?.successful!==true)throw Error('Incomplete Composio response');
 return results[0].response.data;
}
function cursorFrom(next){if(!next)return null;const url=new URL(next);if(url.hostname!=='a.klaviyo.com'||url.protocol!=='https:')throw Error('Invalid report pagination');const cursor=url.searchParams.get('page[cursor]');if(!cursor)throw Error('Missing report cursor');return cursor;}
export function summarize(rows,period,lists,checkedAt){
 const totals=Object.fromEntries(fields.map(k=>[k,0])),seen=new Set(),campaigns=new Set();
 for(const row of rows){if(!['email','sms','push'].includes(row.groupings?.send_channel))throw Error('Unknown report channel');if(row.groupings.send_channel!=='email')continue;
  const {campaign_id,campaign_message_id}=row.groupings;if(!campaign_id||!campaign_message_id)throw Error('Missing campaign identity');const key=campaign_id+':'+campaign_message_id;if(seen.has(key))throw Error('Duplicate campaign row');seen.add(key);campaigns.add(campaign_id);
  for(const key of fields){const n=row.statistics?.[key];if(!Number.isFinite(n)||n<0)throw Error('Missing campaign statistic');totals[key]+=n;}
 }
 const percent=(n,d)=>d>0?n/d*100:null;
 return {checkedAt,mode:'cloud-mcp',masterEmailList:lists[0],smsList:lists[1],from:period.from,through:period.through,period:{start:period.start,end:period.end,timezone:period.timezone},...totals,unsubscribes:totals.unsubscribe_uniques,campaigns:campaigns.size,openRate:percent(totals.opens_unique,totals.delivered),clickRate:percent(totals.clicks_unique,totals.delivered),bounceRate:percent(totals.bounced,totals.recipients),unsubscribeRate:percent(totals.unsubscribe_uniques,totals.delivered),spamRate:percent(totals.spam_complaints,totals.delivered),caveat:'28 completed Chicago days; campaign email only. Unique counts deduplicated per campaign message, not across messages. List counts include profiles whose marketing eligibility has not been verified.'};
}
export async function collectKlaviyo({env=process.env,now=new Date(),clientFactory=()=>new Client({name:'store-pulse-klaviyo',version:'1.0.0'}),pause=ms=>new Promise(r=>setTimeout(r,ms))}={}){
 if(!env.COMPOSIO_CONSUMER_API_KEY||!inRefreshWindow(now))return null;
 const client=clientFactory(),period=reportWindow(now);
 try{
  await client.connect(new StreamableHTTPClientTransport(new URL('https://connect.composio.dev/mcp'),{requestInit:{headers:{'x-consumer-api-key':env.COMPOSIO_CONSUMER_API_KEY}},reconnectionOptions:{maxRetries:0}}));
  const execute=async(slug,args)=>executionResult(await client.callTool({name:'COMPOSIO_MULTI_EXECUTE_TOOL',arguments:{tools:[{tool_slug:slug,account,arguments:args}],sync_response_to_workbench:false,current_step:'REFRESHING_KLAVIYO_AGGREGATES'}},undefined,{timeout:90000}),slug);
  const rows=[],seenCursors=new Set();let cursor;
  for(let page=0;page<10;page++){
   if(page)await pause(31000);
   const report=await execute('KLAVIYO_QUERY_CAMPAIGN_VALUES',{data__attributes__conversion__metric__id:metric,data__attributes__statistics:fields,data__attributes__timeframe:{start:period.start,end:period.end},...(cursor?{page_cursor:cursor}:{})});
   if(!Array.isArray(report.data?.attributes?.results))throw Error('Invalid report schema');rows.push(...report.data.attributes.results);
   cursor=cursorFrom(report.links?.next);if(!cursor)break;if(seenCursors.has(cursor))throw Error('Repeated report cursor');seenCursors.add(cursor);
  }
  if(cursor)throw Error('Incomplete report');
  const lists=[];for(const id of ['SbAEHT','SRttwj']){if(lists.length)await pause(1100);const list=await execute('KLAVIYO_GET_LIST',{id,additional__fields__list:['profile_count'],fields__list:['profile_count']});const count=list.data?.attributes?.profile_count;if(list.data?.id!==id||!Number.isSafeInteger(count)||count<0)throw Error('Invalid list count');lists.push(count);}
  return summarize(rows,period,lists,now.toISOString());
 }finally{await client.close().catch(()=>{});}
}
export function mergeKlaviyo(previous,klaviyo){if(!klaviyo)return previous;const prior=previous||{},beehiiv=prior.beehiiv?{...prior.beehiiv,checkedAt:prior.beehiiv.checkedAt||prior.checkedAt||null}:undefined;return {...prior,checkedAt:klaviyo.checkedAt,...(beehiiv?{beehiiv}:{}),klaviyo};}
