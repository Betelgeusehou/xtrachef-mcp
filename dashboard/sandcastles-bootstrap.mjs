// Explicit operator-only bootstrap. Merely importing collector code never registers a client.
import {issuer,resource,readAuth,saveAuth,tokenRequest,acceptTokens} from './sandcastles-auth.mjs';
if(process.env.SANDCASTLES_BOOTSTRAP_ALLOWED!=='true'){console.log(JSON.stringify({ok:false,reason:'explicit_bootstrap_enable_required'}));process.exit(1);}
const command=process.argv[2],now=new Date();
const print=value=>console.log(JSON.stringify(value));
try{
 let auth=readAuth();
 if(command==='register'){
  if(auth?.client_id){print({ok:true,state:'client_already_registered'});process.exit(0);}
  const response=await fetch(issuer+'/oauth2/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client_name:'Store Pulse Cloud Dashboard',grant_types:['urn:ietf:params:oauth:grant-type:device_code','refresh_token'],token_endpoint_auth_method:'none',scope:'openid profile email offline_access'}),signal:AbortSignal.timeout(45000)});
  if(!response.ok)throw Error('Registration failed');const result=await response.json();if(typeof result.client_id!=='string'||!result.client_id)throw Error('Invalid client');
  saveAuth({client_id:result.client_id,...(result.client_secret?{client_secret:result.client_secret}:{}),token_endpoint_auth_method:result.token_endpoint_auth_method||'none'});print({ok:true,state:'client_registered'});
 }else if(command==='authorize'){
  if(!auth?.client_id)throw Error('Register first');if(auth.refresh_token){print({ok:true,state:'already_authorized'});process.exit(0);}
  let pending=auth.pending;
  if(!pending||pending.expires_at<=now.getTime()){
   const response=await fetch(issuer+'/oauth2/device_authorization',tokenRequest(auth,{scope:'openid profile email offline_access',resource}));if(!response.ok)throw Error('Device authorization failed');const result=await response.json();
   if(!result.device_code||!result.user_code||!result.verification_uri||!Number.isFinite(result.expires_in)||result.expires_in<=0)throw Error('Invalid device response');const verification=new URL(result.verification_uri);if(verification.origin!==issuer)throw Error('Unexpected verification origin');
   pending={device_code:result.device_code,user_code:result.user_code,verification_uri:result.verification_uri,expires_at:now.getTime()+result.expires_in*1000,interval:Math.max(5,Number(result.interval)||5),next_poll_at:now.getTime()};auth={...auth,pending};saveAuth(auth);
  }
  // The owner needs this short-lived user code; access, refresh and device tokens stay private.
  print({ok:true,state:'owner_authorization_required',verificationUri:pending.verification_uri,userCode:pending.user_code,expiresAt:new Date(pending.expires_at).toISOString()});
 }else if(command==='poll'){
  if(!auth?.pending)throw Error('No pending authorization');const pending=auth.pending;
  if(pending.expires_at<=now.getTime()){delete auth.pending;saveAuth(auth);print({ok:false,state:'expired'});process.exit(1);}
  if(now.getTime()<pending.next_poll_at){print({ok:false,state:'wait_before_poll',nextPollAt:new Date(pending.next_poll_at).toISOString()});process.exit(0);}
  pending.next_poll_at=now.getTime()+pending.interval*1000;saveAuth(auth);
  const response=await fetch(issuer+'/oauth2/token',tokenRequest(auth,{grant_type:'urn:ietf:params:oauth:grant-type:device_code',device_code:pending.device_code,resource}));const result=await response.json();
  if(result.error==='authorization_pending'){print({ok:false,state:'owner_authorization_pending'});process.exit(0);}
  if(result.error==='slow_down'){pending.interval+=5;pending.next_poll_at=now.getTime()+pending.interval*1000;saveAuth(auth);print({ok:false,state:'wait_before_poll',nextPollAt:new Date(pending.next_poll_at).toISOString()});process.exit(0);}
  if(!response.ok||result.error)throw Error('Authorization failed');const next=acceptTokens(auth,result,now);if(!next.refresh_token)throw Error('Offline refresh was not granted');delete next.pending;saveAuth(next);print({ok:true,state:'cloud_authorized'});
 }else throw Error('Unknown bootstrap command');
}catch{print({ok:false,state:'bootstrap_failed',message:'No credentials were printed. Check supported registration and device-grant settings.'});process.exitCode=1;}
