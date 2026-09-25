import test from 'node:test';
import assert from 'node:assert/strict';
import {runSource} from './runner.mjs';
test('disabled Sandcastles is explicitly skipped without launching a child or failing the hour',async()=>{
 for(const env of [{},{SANDCASTLES_ENABLED:'false'}]){
  const result=await runSource('refresh-sandcastles.mjs',[],{env,execute:()=>assert.fail('disabled collector must not execute')});
  assert.equal(result.ok,true);assert.equal(result.skipped,true);assert.equal(result.outcome,'disabled');assert.equal(result.source,'refresh-sandcastles.mjs');
 }
});
test('enabled Sandcastles and existing sources preserve executor results including errors',async()=>{
 for(const [script,env] of [['refresh-sandcastles.mjs',{SANDCASTLES_ENABLED:'true'}],['orders.mjs',{}],['prime.mjs',{}]]){
  const expected={source:script,ok:false,reason:'timeout'};
  const result=await runSource(script,['example'],{env,execute:async(source,args)=>{assert.equal(source,script);assert.deepEqual(args,['example']);return expected;}});
  assert.equal(result,expected);
 }
});
import {invoiceRefreshTargets} from './runner.mjs';
test('new invoice import refreshes stale affected months without duplicating current month',()=>{const store={last_ingest:'2026-09-25T19:22:00Z',lines:[{invoice_date:'2026-08-24'}]},now=new Date('2026-09-25T20:00:00Z'),fresh={generatedAt:'2026-09-25T19:23:00Z'},old={generatedAt:'2026-09-24T19:00:00Z'};assert.deepEqual(invoiceRefreshTargets(store,fresh,old,now),['primePrevious']);assert.deepEqual(invoiceRefreshTargets(store,fresh,fresh,now),[]);assert.deepEqual(invoiceRefreshTargets(store,old,old,now),['prime','primePrevious']);assert.deepEqual(invoiceRefreshTargets({...store,lines:[{invoice_date:'2026-09-24'}]},fresh,old,now),[]);});
