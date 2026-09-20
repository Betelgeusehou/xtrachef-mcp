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
