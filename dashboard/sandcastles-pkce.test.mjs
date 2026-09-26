import test from 'node:test';import assert from 'node:assert/strict';import crypto from 'node:crypto';
import {createAuthorization,completeAuthorization,callbackPath,validateRedirect} from './sandcastles-pkce.mjs';
process.env.RAILWAY_PUBLIC_DOMAIN='collector-test.up.railway.app';
const redirect='https://collector-test.up.railway.app'+callbackPath, now=new Date('2026-09-25T12:00:00Z');
const auth={client_id:'client',grant_types:['authorization_code','refresh_token'],redirect_uris:[redirect],access_token:'old-access',refresh_token:'old-refresh'};
function setup(){let pending;const link=createAuthorization({auth,redirectUri:redirect,now,persist:p=>pending=p});const saved=pending;let writes=[];const consume=state=>{if(state!==pending?.state)return null;const p=pending;pending=null;return p;};return {link,saved,consume,writes,base:{redirectUri:redirect,now,consume,load:()=>auth,persist:v=>writes.push(v)}};}
test('S256 challenge, private verifier and exact redirect',()=>{const x=setup(),u=new URL(x.link.authorizationUrl);assert.equal(u.searchParams.get('code_challenge'),crypto.createHash('sha256').update(x.saved.verifier).digest('base64url'));assert.equal(u.searchParams.get('code_challenge_method'),'S256');assert.ok(!x.link.authorizationUrl.includes(x.saved.verifier));assert.throws(()=>validateRedirect('https://collector-test.up.railway.app/wrong'));assert.throws(()=>validateRedirect('https://other.up.railway.app'+callbackPath));assert.throws(()=>validateRedirect('https://example.com'+callbackPath));});
test('one exchange only and successful tokens persist privately',async()=>{const x=setup(),params=new URLSearchParams({state:x.saved.state,code:'secret-code'});let calls=0;const fetchImpl=async(url,request)=>{calls++;assert.equal(request.body.get('code_verifier'),x.saved.verifier);return {ok:true,json:async()=>({access_token:'secret-access',refresh_token:'secret-refresh',expires_in:3600,token_type:'Bearer'})};};const result=await completeAuthorization({...x.base,params,fetchImpl});assert.deepEqual(result,{ok:true,state:'cloud_authorized'});assert.equal(x.writes.length,1);await assert.rejects(()=>completeAuthorization({...x.base,params,fetchImpl}));assert.equal(calls,1);assert.ok(!JSON.stringify(result).includes('secret'));});
test('expiry, wrong state, denial, redirect change and failed exchange preserve prior tokens',async()=>{for(const mode of ['expired','state','denied','redirect','http','malformed']){const x=setup(),params=new URLSearchParams({state:x.saved.state,code:'secret-code'});let calls=0;const args={...x.base,params,fetchImpl:async()=>{calls++;return {ok:mode!=='http',json:async()=>({access_token:'secret',expires_in:0})};}};if(mode==='expired')args.now=new Date(now.getTime()+600001);if(mode==='state')params.set('state','wrong');if(mode==='denied')params.set('error','access_denied');if(mode==='redirect')args.redirectUri='https://other.example'+callbackPath;await assert.rejects(()=>completeAuthorization(args));assert.equal(x.writes.length,0);assert.equal(auth.refresh_token,'old-refresh');if(!['http','malformed'].includes(mode))assert.equal(calls,0);}});

test('HTTP callback is gated and never echoes authorization query values',async()=>{
 const {handleDashboard}=await import('./http.mjs');
 const oldEnabled=process.env.SANDCASTLES_OAUTH_CALLBACK_ENABLED,oldRedirect=process.env.SANDCASTLES_REDIRECT_URI;
 const secret='never-echo-auth-code';const logs=[];const oldLog=console.log,oldError=console.error;console.log=(...x)=>logs.push(x);console.error=(...x)=>logs.push(x);
 try {
  for(const enabled of ['false','true']){
   process.env.SANDCASTLES_OAUTH_CALLBACK_ENABLED=enabled;process.env.SANDCASTLES_REDIRECT_URI=redirect;
   let status,headers,text;const res={writeHead:(s,h)=>{status=s;headers=h;},end:v=>text=v};
   assert.equal(await handleDashboard({url:callbackPath+'?state=wrong&code='+secret,method:'GET',headers:{}},res),true);
   assert.equal(status,enabled==='true'?400:404);assert.equal(headers['Referrer-Policy'],'no-referrer');assert.equal(headers['Cache-Control'],'no-store');assert.ok(!text.includes(secret));
  }
  assert.ok(!JSON.stringify(logs).includes(secret));
 }finally{console.log=oldLog;console.error=oldError;if(oldEnabled===undefined)delete process.env.SANDCASTLES_OAUTH_CALLBACK_ENABLED;else process.env.SANDCASTLES_OAUTH_CALLBACK_ENABLED=oldEnabled;if(oldRedirect===undefined)delete process.env.SANDCASTLES_REDIRECT_URI;else process.env.SANDCASTLES_REDIRECT_URI=oldRedirect;}
});


test('enabled collector prevents authorize and callback before persistence or consumption',async()=>{
 const prior=process.env.SANDCASTLES_ENABLED;process.env.SANDCASTLES_ENABLED='true';
 try{assert.throws(()=>createAuthorization({auth,redirectUri:redirect,persist:()=>assert.fail('persist')}));await assert.rejects(()=>completeAuthorization({params:new URLSearchParams(),redirectUri:redirect,consume:()=>assert.fail('consume'),fetchImpl:()=>assert.fail('network')}));}finally{if(prior===undefined)delete process.env.SANDCASTLES_ENABLED;else process.env.SANDCASTLES_ENABLED=prior;}
});
test('real filesystem claim is single-use and rejects replacement between read and claim',async()=>{
 const fs=(await import('node:fs')).default,os=await import('node:os'),path=await import('node:path');const {consumePending}=await import('./sandcastles-pkce.mjs');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'store-pulse-pkce-')),file=path.join(dir,'pending.json');const x=setup();
 try{
  fs.writeFileSync(file,JSON.stringify(x.saved));assert.deepEqual(consumePending(x.saved.state,file),x.saved);assert.equal(consumePending(x.saved.state,file),null);assert.equal(fs.readdirSync(dir).length,0);
  fs.writeFileSync(file,JSON.stringify(x.saved));assert.equal(consumePending('wrong',file),null);assert.ok(fs.existsSync(file));
  const rename=fs.renameSync;fs.renameSync=(from,to)=>{fs.writeFileSync(from,JSON.stringify({...x.saved,state:'b'.repeat(43),verifier:'c'.repeat(43)}));return rename(from,to);};
  try{assert.equal(consumePending(x.saved.state,file),null);}finally{fs.renameSync=rename;}
  assert.equal(fs.readdirSync(dir).length,0);
  fs.writeFileSync(file,JSON.stringify({...x.saved,verifier:'invalid'}));assert.equal(consumePending(x.saved.state,file),null);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
