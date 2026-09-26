const allowedErrors = new Set(['invalid_client_metadata','invalid_redirect_uri','invalid_request','invalid_client','unauthorized_client','unsupported_grant_type','invalid_scope','access_denied','server_error','temporarily_unavailable']);
export function bootstrapDiagnostic(stage, response, payload) {
  return {ok:false,state:'bootstrap_failed',stage, httpStatus:Number.isInteger(response?.status)?response.status:null,
    oauthError:allowedErrors.has(payload?.error)?payload.error:null};
}
export function pkceRegistration(redirectUri) {
  const url=new URL(redirectUri);
  if(url.protocol!=='https:' || url.username || url.password || url.hash || url.search || url.hostname==='localhost') throw Error('Invalid HTTPS callback');
  return {client_name:'Store Pulse Cloud Dashboard',grant_types:['authorization_code','refresh_token'],response_types:['code'],redirect_uris:[url.href],token_endpoint_auth_method:'none',scope:'openid profile email offline_access'};
}
