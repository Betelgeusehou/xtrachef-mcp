import fs from 'node:fs';
export function lockCollector(file){
 for(let attempt=0;attempt<2;attempt++){try{fs.writeFileSync(file,String(process.pid),{flag:'wx'});const release=()=>{try{if(fs.readFileSync(file,'utf8')===String(process.pid))fs.unlinkSync(file);}catch{}};process.on('exit',release);process.on('SIGINT',()=>process.exit(0));process.on('SIGTERM',()=>process.exit(0));return true;}catch(e){if(e.code!=='EEXIST')throw e;const pid=Number(fs.readFileSync(file,'utf8'));if(!Number.isInteger(pid)||pid<1)throw Error('Invalid collector lock');try{process.kill(pid,0);return false;}catch(check){if(check.code!=='ESRCH')throw check;fs.unlinkSync(file);}}}return false;
}
