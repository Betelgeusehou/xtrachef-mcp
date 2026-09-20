import {Client} from '@modelcontextprotocol/sdk/client/index.js';import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {accessToken,readAuth,resource} from './sandcastles-auth.mjs';import {inRefreshWindow} from './refresh-schedule.mjs';
// IDs verified from the existing authenticated dashboard, never discovered by a paid call.
export const channels={chriscusack_:'9526dc7f-f74b-4f82-81c3-d95211ab8de4',betelgeusehou:'155ed755-7313-46f4-a861-ce10e9a8ee43',betelgeusemontrose:'5305a2ef-dcf2-41ff-971f-b86d6c04ffde'};
export const upstreamIntervalMs=60*60*1000;
export function mapSocial(previous,payload,now=new Date()){
 const chart=payload?.charts,points=chart?.points;if(!Array.isArray(points)||points.length!==7)throw Error('Incomplete seven-day analytics');
 const dates=points.map(p=>p.date);for(let i=0;i<dates.length;i++){if(!/^\d{4}-\d{2}-\d{2}$/.test(dates[i])||!Number.isFinite(Date.parse(dates[i]))||new Date(dates[i]).toISOString().slice(0,10)!==dates[i]||(i&&Date.parse(dates[i])-Date.parse(dates[i-1])!==86400000))throw Error('Invalid analytics dates');}
 const today=now.toLocaleDateString('en-CA',{timeZone:'America/Chicago'});
 if(dates[6]>today||previous?.periodThrough&&dates[6]<previous.periodThrough||previous?.periodFrom&&dates[0]<previous.periodFrom)throw Error('Future or regressed analytics period');
 const last=points.at(-1),accounts=previous?.accounts;if(!Array.isArray(accounts)||accounts.length!==3||new Set(accounts.map(a=>a.handle)).size!==3)throw Error('Verified three-account seed required');
 const valid=n=>Number.isSafeInteger(n)&&n>=0;
 const mapped=accounts.map(account=>{const id=channels[account.handle];if(!id)throw Error('Unexpected channel');const followers=last.followers?.[id],views=last.views?.[id],baseline=chart.views_baseline?.[id],posts=last.posts?.[id],followerBaseline=chart.followers_baseline?.[id];if(![followers,views,baseline,posts].every(valid)||views<baseline)throw Error('Incomplete channel analytics');return {...account,followers,gained:valid(followerBaseline)?followers-followerBaseline:null,views:(views-baseline).toLocaleString('en-US'),posts,periodFrom:dates[0],periodThrough:dates[6],monitoringStart:valid(followerBaseline)?null:chart.followers_started?.[id]??dates[6]};});
 return {...previous,checkedDate:today,checkedAt:now.toISOString(),mode:'cloud-mcp',upstreamIntervalHours:1,sourceRefreshHours:12,periodFrom:dates[0],periodThrough:dates[6],accounts:mapped};
}
export async function collectSandcastles({previous,env=process.env,now=new Date(),auth=readAuth(),fetchImpl=fetch,persistAuth,clientFactory=()=>new Client({name:'store-pulse-social',version:'1.0.0'})}={}){
 if(env.SANDCASTLES_ENABLED!=='true'||!inRefreshWindow(now))return null;
 const last=Date.parse(previous?.checkedAt);if(Number.isFinite(last)&&now.getTime()-last<upstreamIntervalMs)return null;
 const token=await accessToken({auth,now,fetchImpl,...(persistAuth?{persist:persistAuth}:{})}),client=clientFactory();
 try{await client.connect(new StreamableHTTPClientTransport(new URL(resource),{requestInit:{headers:{Authorization:'Bearer '+token}},reconnectionOptions:{maxRetries:0}}));const result=await client.callTool({name:'get_personal_analytics',arguments:{}},undefined,{timeout:90000});if(result.isError)throw Error('Social read failed');const payload=result.structuredContent??JSON.parse(result.content.find(x=>x.type==='text').text);return mapSocial(previous,payload,now);}finally{await client.close().catch(()=>{});}
}
