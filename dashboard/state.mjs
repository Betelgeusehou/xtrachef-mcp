import {activityEvents,activityStatus} from './activity.mjs';
import fs from 'node:fs';
import path from 'node:path';
export const dataDir=()=>process.env.DASHBOARD_DATA_DIR||'/data/dashboard';
export function atomic(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file+'.tmp',JSON.stringify(value));fs.renameSync(file+'.tmp',file);}
export function load(file){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return null;}}
export const sources=['orders','prime','social','email','primePrevious'];
export function collectedAt(source,value){return source==='orders'||source==='prime'||source==='primePrevious'?value?.generatedAt:value?.checkedAt||value?.generatedAt||value?.verifiedAt;}
export function validateSnapshot(source,value,now=Date.now()){
 if(!sources.includes(source)||!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid snapshot source');
 const at=Date.parse(collectedAt(source,value));if(!Number.isFinite(at)||at>now+300000)throw Error('Invalid snapshot timestamp');
 if(source==='orders'&&(!Array.isArray(value.stores)||!/^\d{4}-\d{2}-\d{2}$/.test(value.businessDate)))throw Error('Invalid order snapshot');
 if((source==='prime'||source==='primePrevious')&&(!value.groups||!Array.isArray(value.days)))throw Error('Invalid prime snapshot');
 if(source==='social'&&!Array.isArray(value.accounts))throw Error('Invalid social snapshot');
 return at;
}
export function saveSnapshot(source,value){const at=validateSnapshot(source,value),file=path.join(dataDir(),source,'snapshot.json'),prior=load(file);if(prior&&Date.parse(collectedAt(source,prior))>=at)return false;atomic(file,value);return true;}
export function snapshots(){const result={};for(const source of sources){const value=load(path.join(dataDir(),source,'snapshot.json'));if(value)result[source]=value;}return {activity:activityEvents(),activityStatus:activityStatus(),snapshots:result,collectedAt:Object.entries(result).map(([s,v])=>collectedAt(s,v)).filter(Boolean).sort().at(-1)||null,collector:load(path.join(dataDir(),'run-status.json'))};}
