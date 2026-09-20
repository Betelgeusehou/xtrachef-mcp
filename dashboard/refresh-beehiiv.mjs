import path from 'node:path';
import {dataDir,load,atomic,saveSnapshot} from './state.mjs';
import {collectBeehiiv,mergeBeehiiv} from './beehiiv.mjs';
try{const beehiiv=await collectBeehiiv();if(beehiiv){const file=path.join(dataDir(),'email','snapshot.json');saveSnapshot('email',mergeBeehiiv(load(file),beehiiv));atomic(path.join(dataDir(),'beehiiv-status.json'),{state:'ready',checkedAt:beehiiv.checkedAt,sourceUpdatedAt:beehiiv.sourceUpdatedAt});}}
catch{atomic(path.join(dataDir(),'beehiiv-status.json'),{state:'error',attemptedAt:new Date().toISOString(),message:'beehiiv refresh failed; last verified values retained.'});process.exitCode=1;}
