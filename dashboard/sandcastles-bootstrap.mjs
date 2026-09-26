import {createAuthorization,validateRedirect} from './sandcastles-pkce.mjs';
// Explicit operator-only bootstrap. Merely importing collector code never registers a client.
import {issuer,resource,readAuth,saveAuth,tokenRequest,acceptTokens} from './sandcastles-auth.mjs';
if(process.env.SANDCASTLES_BOOTSTRAP_ALLOWED!=='true'){console.log(JSON.stringify({ok:false,reason:'explicit_bootstrap_enable_required'}));process.exit(1);}
import {bootstrapDiagnostic,pkceRegistration} from './sandcastles-bootstrap-support.mjs';
const command=process.argv[2],now=new Date();
let stage='validate',failureResponse=null,failurePayload=null;
const print=value=>console.log(JSON.stringify(value));
try{
 if(command==='prepare-pkce'){const metadata=pkceRegistration(validateRedirect(process.env.SANDCASTLES_REDIRECT_URI));print({ok:true,state:'prepared_only',metadata,message:'No registration performed. Callback implementation is prepared; verify deployed routing and configuration before registration.'});process.exit(0);}
 let auth=readAuth();
 if(command==='authorize-pkce'){print({ok:true,state:'owner_authorization_required',...createAuthorization({auth,redirectUri:process.env.SANDCASTLES_REDIRECT_URI,now})});process.exit(0);}
 if(command==='register'||command==='register-pkce'){
  if(auth?.client_id){print({ok:true,state:'client_already_registered'});process.exit(0);}
  stage='register';
  const metadata=command==='register-pkce'?pkceRegistration(validateRedirect(process.env.SANDCASTLES_REDIRECT_URI)):{client_name:'Store Pulse Cloud Dashboard',grant_types:['urn:ietf:params:oauth:grant-type:device_code','refresh_token'],token_endpoint_auth_method:'none',scope:'openid profile email offline_access'};
  const response=await fetch(issuer+'/oauth2/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(metadata),signal:AbortSignal.timeout(45000)});
  failureResponse=response;const result=await response.json();failurePayload=result;if(!response.ok)throw Error('Registration failed');if(typeof result.client_id!=='string'||!result.client_id)throw Error('Invalid client');
  saveAuth({grant_types:result.grant_types||metadata.grant_types,redirect_uris:result.redirect_uris||metadata.redirect_uris,client_id:result.client_id,...(result.client_secret?{client_secret:result.client_secret}:{}),token_endpoint_auth_method:result.token_endpoint_auth_method||'none'});print({ok:true,state:'client_registered'});
 }else if(command==='authorize'){
  if(!auth?.client_id)throw Error('Register first');if(auth.refresh_token){print({ok:true,state:'already_authorized'});process.exit(0);}
  let pending=auth.pending;
  if(!pending||pending.expires_at<=now.getTime()){
   stage='device_authorization';
   const response=await fetch(issuer+'/oauth2/device_authorization',tokenRequest(auth,{scope:'openid profile email offline_access',resource}));failureResponse=response;const result=await response.json();failurePayload=result;if(!response.ok)throw Error('Device authorization failed');
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
  stage='token';
  const response=await fetch(issuer+'/oauth2/token',tokenRequest(auth,{grant_type:'urn:ietf:params:oauth:grant-type:device_code',device_code:pending.device_code,resource}));failureResponse=response;const result=await response.json();failurePayload=result;
  if(result.error==='authorization_pending'){print({ok:false,state:'owner_authorization_pending'});process.exit(0);}
  if(result.error==='slow_down'){pending.interval+=5;pending.next_poll_at=now.getTime()+pending.interval*1000;saveAuth(auth);print({ok:false,state:'wait_before_poll',nextPollAt:new Date(pending.next_poll_at).toISOString()});process.exit(0);}
  if(!response.ok||result.error)throw Error('Authorization failed');const next=acceptTokens(auth,result,now);if(!next.refresh_token)throw Error('Offline refresh was not granted');delete next.pending;saveAuth(next);print({ok:true,state:'cloud_authorized'});
 }else throw Error('Unknown bootstrap command');
}catch{print(bootstrapDiagnostic(stage,failureResponse,failurePayload));process.exitCode=1;}





