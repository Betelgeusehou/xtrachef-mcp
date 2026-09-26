import crypto from 'node:crypto';
import fs from 'node:fs';
import {authPath,readAuth,saveAuth,issuer,resource,tokenRequest,acceptTokens} from './sandcastles-auth.mjs';
import {pkceRegistration} from './sandcastles-bootstrap-support.mjs';
export const callbackPath='/dashboard/oauth/sandcastles/callback';
const pendingPath=()=>authPath()+'.pkce';
export function validateRedirect(uri){const domain=process.env.RAILWAY_PUBLIC_DOMAIN;if(typeof domain!=='string'||!/^[a-z0-9][a-z0-9.-]*\.up\.railway\.app$/i.test(domain))throw Error('Existing Railway public domain required');const valid=pkceRegistration(uri).redirect_uris[0],url=new URL(valid);if(url.origin!=='https://'+domain.toLowerCase()||url.pathname!==callbackPath)throw Error('Callback must use existing service origin and path');return valid;}
export function createAuthorization({auth,redirectUri,now=new Date(),persist=p=>saveAuth(p,pendingPath())}){
 if(process.env.SANDCASTLES_ENABLED==='true')throw Error('Disable collector before authorization');
 const redirect=validateRedirect(redirectUri);
 if(!auth?.client_id||!auth.redirect_uris?.includes(redirect)||!auth.grant_types?.includes('authorization_code'))throw Error('PKCE client registration required');
 const verifier=crypto.randomBytes(32).toString('base64url'),state=crypto.randomBytes(32).toString('base64url');
 const pending={state,verifier,redirectUri:redirect,clientId:auth.client_id,expiresAt:now.getTime()+600000};persist(pending);
 const url=new URL(issuer+'/oauth2/authorize');url.search=new URLSearchParams({client_id:auth.client_id,response_type:'code',redirect_uri:redirect,scope:'openid profile email offline_access',resource,state,code_challenge:crypto.createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'}).toString();
 return {authorizationUrl:url.href,expiresAt:new Date(pending.expiresAt).toISOString()};
}
function matchingState(state,pending){return typeof state==='string'&&/^[A-Za-z0-9_-]{43}$/.test(state)&&typeof pending?.state==='string'&&state.length===pending.state.length&&crypto.timingSafeEqual(Buffer.from(state),Buffer.from(pending.state));}
function validPending(state,pending){return matchingState(state,pending)&&typeof pending.verifier==='string'&&/^[A-Za-z0-9_-]{43}$/.test(pending.verifier)&&typeof pending.clientId==='string'&&pending.clientId.length>0&&typeof pending.redirectUri==='string'&&Number.isFinite(pending.expiresAt);}
export function consumePending(state,file=pendingPath()){
 const pending=readAuth(file);if(!validPending(state,pending))return null;
 const claimed=file+'.claimed-'+crypto.randomUUID();try{fs.renameSync(file,claimed);}catch{return null;}
 try{const actual=JSON.parse(fs.readFileSync(claimed,'utf8'));return validPending(state,actual)&&actual.verifier===pending.verifier&&actual.clientId===pending.clientId&&actual.redirectUri===pending.redirectUri&&actual.expiresAt===pending.expiresAt?actual:null;}finally{fs.unlinkSync(claimed);}
}
export async function completeAuthorization({params,redirectUri,now=new Date(),consume=consumePending,load=readAuth,persist=saveAuth,fetchImpl=fetch}){
 // Consume before awaiting network: replay/concurrent callbacks cannot exchange twice.
 if(process.env.SANDCASTLES_ENABLED==='true')throw Error('Disable collector before authorization');
 const redirect=validateRedirect(redirectUri);
 if(params.getAll('state').length!==1||params.getAll('code').length>1)throw Error('Invalid callback');
 const pending=consume(params.get('state'));
 if(!pending||!Number.isFinite(pending.expiresAt)||pending.expiresAt<=now.getTime()||pending.redirectUri!==redirect)throw Error('Invalid or expired authorization');
 const auth=load();
 if(auth?.client_id!==pending.clientId||!auth.redirect_uris?.includes(redirect))throw Error('Client changed');
 const code=params.get('code');if(params.has('error')||!code||code.length>4096)throw Error('Authorization denied');
 const response=await fetchImpl(issuer+'/oauth2/token',tokenRequest(auth,{grant_type:'authorization_code',code,code_verifier:pending.verifier,redirect_uri:redirect,resource}));
 if(!response.ok)throw Error('Token exchange failed');
 const result=await response.json();if(!result.refresh_token)throw Error('Offline access required');
 const next=acceptTokens(auth,result,now);persist(next);return {ok:true,state:'cloud_authorized'};
}
export async function handleSandcastlesCallback(req,res){
 const url=new URL(req.url,'http://localhost');if(url.pathname!==callbackPath)return false;
 const finish=(status,message)=>{res.writeHead(status,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'"});res.end(message);};
 if(req.method!=='GET'||process.env.SANDCASTLES_OAUTH_CALLBACK_ENABLED!=='true'){finish(404,'Not found');return true;}
 try{await completeAuthorization({params:url.searchParams,redirectUri:process.env.SANDCASTLES_REDIRECT_URI});finish(200,'Sandcastles cloud authorization completed. You can close this page.');}catch{finish(400,'Authorization could not be completed. Existing data retained. Request a new authorization link.');}return true;
}


