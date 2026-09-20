// Official read-only API; no subscriber addresses or individual engagement data requested.
import {inRefreshWindow} from './refresh-schedule.mjs';
export const publicationId='pub_fcd4a61d-3672-4d96-a6fc-7ae8943b3a51';
const base='https://api.beehiiv.com/v2/publications/'+publicationId;
const count=value=>Number.isSafeInteger(value)&&value>=0?value:null;
const rate=value=>Number.isFinite(value)&&value>=0&&value<=100?value/100:null;
async function read(fetchImpl,url,key){const response=await fetchImpl(url,{headers:{Authorization:'Bearer '+key},signal:AbortSignal.timeout(45000)});if(!response.ok)throw Error('beehiiv read failed');return response.json();}
export async function collectBeehiiv({env=process.env,now=new Date(),fetchImpl=fetch}={}){
 if(!env.BEEHIIV_API_KEY||!inRefreshWindow(now))return null;
 const [publication,result]=await Promise.all([read(fetchImpl,base+'?expand%5B%5D=stats',env.BEEHIIV_API_KEY),read(fetchImpl,base+'/posts/aggregate_stats',env.BEEHIIV_API_KEY)]);
 const p=publication.data,email=result.data?.stats?.email;
 if(p?.id!==publicationId||typeof p.name!=='string'||count(p.stats?.active_subscriptions)===null||!email||typeof email!=='object')throw Error('Unexpected beehiiv schema');
 const checkedAt=now.toISOString();const computed=result.data.computed_at;
 const sourceUpdatedAt=Number.isFinite(computed)&&computed>=0&&computed*1000<=now.getTime()+300000?new Date(computed*1000).toISOString():null;
 const providerOpenRate=rate(email.open_rate),providerClickRate=rate(email.click_rate);
 const delivered=count(email.delivered),uniqueOpens=count(email.unique_opens),uniqueClicks=count(email.unique_clicks);
 if(delivered===null||uniqueOpens===null||uniqueClicks===null)throw Error('Invalid beehiiv counts');
 const openRate=delivered>0?uniqueOpens/delivered:null,clickRate=delivered>0?uniqueClicks/delivered:null;
 const metrics={};for(const key of ['recipients','delivered','opens','unique_opens','clicks','unique_clicks','unsubscribes','spam_reports'])metrics[key]=count(email[key]);
 return {publicationId,name:p.name,checkedAt,sourceUpdatedAt,mode:'cloud-api',period:{key:'all_posts',exactBoundaries:null},activeSubscribers:p.stats.active_subscriptions,newSubscribers:null,churnedSubscribers:null,netSubscribers:null,openRate,clickRate,providerOpenRate,providerClickRate,rateDefinition:'Unique email opens or clicks divided by delivered emails, summed across all posts.',metrics,caveat:'Active subscribers are current. Engagement rates cover all posts, not the last four weeks. Subscriber growth for a defined period is unavailable from these aggregate endpoints.'};
}
export function mergeBeehiiv(previous,beehiiv){
 if(!beehiiv)return previous;
 // Envelope time is latest write only. Every provider retains its own verified timestamp.
 const prior=previous||{},klaviyo=prior.klaviyo?{...prior.klaviyo,checkedAt:prior.klaviyo.checkedAt||prior.checkedAt||null}:undefined;
 return {...prior,checkedAt:beehiiv.checkedAt,...(klaviyo?{klaviyo}:{}),beehiiv};
}
