import path from 'node:path';import {dataDir,load,atomic,saveSnapshot} from './state.mjs';import {collectKlaviyo,mergeKlaviyo} from './klaviyo.mjs';
try{const klaviyo=await collectKlaviyo();if(klaviyo){saveSnapshot('email',mergeKlaviyo(load(path.join(dataDir(),'email/snapshot.json')),klaviyo));atomic(path.join(dataDir(),'klaviyo-status.json'),{state:'ready',checkedAt:klaviyo.checkedAt});}}
catch{atomic(path.join(dataDir(),'klaviyo-status.json'),{state:'error',attemptedAt:new Date().toISOString(),message:'Klaviyo refresh failed; last verified values retained.'});process.exitCode=1;}
