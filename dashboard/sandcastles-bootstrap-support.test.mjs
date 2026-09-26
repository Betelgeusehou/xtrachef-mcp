import test from 'node:test';
import assert from 'node:assert/strict';
import {bootstrapDiagnostic,pkceRegistration} from './sandcastles-bootstrap-support.mjs';
test('diagnostics only retain allowlisted error and HTTP status',()=>{
 const secret='NEVER_PRINT_TOKEN';
 const result=bootstrapDiagnostic('register',{status:400,headers:{Authorization:secret}},{error:'invalid_client_metadata',error_description:secret,access_token:secret,refresh_token:secret,client_secret:secret});
 assert.deepEqual(result,{ok:false,state:'bootstrap_failed',stage:'register',httpStatus:400,oauthError:'invalid_client_metadata'});
 assert.ok(!JSON.stringify(result).includes(secret));
 assert.equal(bootstrapDiagnostic('poll',{status:500},{error:secret}).oauthError,null);
});
test('PKCE registration is explicit and rejects unsafe callback URLs',()=>{
 const result=pkceRegistration('https://example.com/oauth/sandcastles/callback');
 assert.deepEqual(result.grant_types,['authorization_code','refresh_token']);
 assert.deepEqual(result.response_types,['code']);
 assert.equal(result.token_endpoint_auth_method,'none');
 for(const url of ['http://example.com/cb','https://user:pass@example.com/cb','https://example.com/cb?token=x','https://example.com/cb#x'])assert.throws(()=>pkceRegistration(url));
});
