const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const test=require('node:test');
const wt=path.resolve(__dirname,'..');
const state=require(path.join(wt,'src/state.js'));
const contracts=require(path.join(wt,'dist/state/direct-post/contracts.js'));
const direct=require(path.join(wt,'src/state/direct-post.js'));
const {fixture}=require(path.join(wt,'test/direct-post-fixture.js'));
const pub=require(path.join(wt,'test/town-hall-publication-scenarios-fixtures.cjs'));
const {detect,values,inventory,predicateDefinitions,declaresFunction,collectSourceSnapshots}=require('./direct-post-outcome-membership-inventory.cjs');
const names=["contracts predicate accepts exactly the six known outcomes","contracts predicate rejects invalid and nonprimitive outcomes","public outcome vocabularies retain their shapes and identities","transport preserves all known error outcomes","transport normalizes invalid error outcomes to unknown","preflight accepts all known outcomes without a send","preflight rejects invalid outcomes without creating receipts","outcome recording accepts all known outcomes","outcome recording rejects invalid values without changing receipts","invalid and unknown projections retain unresolved binding custody","invalid persisted publication outcomes refuse without journal mutation","publication recording preserves known outcomes and invalid refusals","all full-domain membership consumers delegate to the contracts owner","membership inventory detects new private classifiers without banning vocabulary transfer"];
const invalid=[undefined,null,false,true,0,42,NaN,'','bogus','claimed','in_flight',[],{},new String('sent'),Symbol('sent'),1n];
function meta(f,id,partCount=1){const binding=f.state.getBinding('channel');return {requestId:id,inReplyTo:null,attemptId:'attempt-'+id,sourcePath:f.textFile,textHash:'text',operatorId:'operator',partHash:'part',channelId:'channel',guildId:'guild',provider:'codex',nativeId:f.nativeId,generation:1,conductorId:'conductor',repoKey:'repo:fixture',partIndex:0,partCount,nonce:'nonce-'+id,binding};}
function assertStoredEventBytes(store, row, expected) {
 const raw = store.db.prepare('SELECT detail FROM receipts WHERE id=?').get(row.id);
 assert.equal(raw.detail, JSON.stringify(expected));
}
function invalidError(fn){assert.throws(fn,e=>e instanceof state.BindingError&&e.message==='invalid direct post outcome');}
function openPublication(t){const f=pub.fixture(t),created=f.state.createTownHallBroadcast(pub.input());const key=created.broadcast.journalKey;const reserved=f.state.reserveTownHallPublication(key);const attempt=reserved.publication.attemptId;f.state.markTownHallPublicationInFlight(key,attempt);return {...f,key,attempt};}
async function transport(t,candidates,expectedOverride){
 const discord=require(path.join(wt,'src/discord.js'));const original=discord.sendDiscordMessage;
 const facade=require.resolve(path.join(wt,'src/direct-post.js')),generated=require.resolve(path.join(wt,'dist/direct-post.js'));
 const cached=new Map([facade,generated].map(p=>[p,require.cache[p]]));let candidate,calls=0;
 try{discord.sendDiscordMessage=async()=>{calls++;throw Object.assign(new Error('fixture failure'),{outcome:candidate});};delete require.cache[facade];delete require.cache[generated];const {runDirectPost}=require(facade);
 for(const [index,value]of candidates.entries()){candidate=value;const f=fixture(t);fs.writeFileSync(f.textFile,'fixture');const before=calls;const expected=expectedOverride===undefined?(values.includes(value)?value:'unknown'):expectedOverride;const result=await runDirectPost({state:f.state,token:'fixture',nativeId:f.nativeId,generation:1,textFile:f.textFile,dedupeKey:'outcome-'+index,fetchImpl:async()=>{throw Error('network forbidden');}});assert.equal(calls-before,1);assert.equal(result.status,expected);assert.equal(result.parts[0].status,expected);assert.equal(result.messageIds.length,0);const outcomes=f.state.directPostRows(result.requestId).filter(r=>r.detail.outcome!==undefined);assert.equal(outcomes.length,1);assert.equal(outcomes[0].detail.outcome,expected);}
 }finally{discord.sendDiscordMessage=original;for(const [p,m]of cached){if(m)require.cache[p]=m;else delete require.cache[p];}}
}
test(names[0],()=>{assert.equal(typeof contracts.isDirectPostOutcome,'function');for(const value of values)assert.equal(contracts.isDirectPostOutcome(value),true);});
test(names[1],()=>{assert.equal(typeof contracts.isDirectPostOutcome,'function');for(const value of invalid)assert.equal(contracts.isDirectPostOutcome(value),false);});
test(names[2],()=>{assert.strictEqual(state.DIRECT_POST_OUTCOMES,direct.DIRECT_POST_OUTCOMES);assert.strictEqual(direct.DIRECT_POST_OUTCOMES,contracts.DIRECT_POST_OUTCOMES);assert.ok(Object.isFrozen(contracts.DIRECT_POST_OUTCOMES));assert.deepEqual(contracts.DIRECT_POST_OUTCOMES,values);const wrapper=require(path.join(wt,'src/direct-post.js'));assert.equal(Object.hasOwn(wrapper,'DIRECT_POST_OUTCOMES'),false);const transport=require(path.join(wt,'dist/direct-post.js'));const owner=require(path.join(wt,'dist/direct-post/contracts.js'));assert.strictEqual(transport.DIRECT_POST_OUTCOMES,owner.DIRECT_POST_OUTCOMES);assert.ok(!Array.isArray(owner.DIRECT_POST_OUTCOMES));assert.deepEqual(Object.values(owner.DIRECT_POST_OUTCOMES),values);});
test(names[3],t=>transport(t,values));
test(names[4],t=>transport(t,invalid));
test(names[5],t=>{for(const [i,value]of values.entries()){const f=fixture(t),m=meta(f,'preflight-'+i);const result=f.state.recordDirectPostPreflight(m,value);assert.equal(result.outcome,value);const rows=f.state.directPostRows(m.requestId);assert.equal(rows.length,1);assert.equal(rows[0].detail.outcome,value);assert.equal(rows[0].detail.phase,'preflight');const {attemptId,...preflightMeta}=m;assertStoredEventBytes(f.state,rows[0],{journal:'direct-post-v1',...preflightMeta,phase:'preflight',outcome:value});}});
test(names[6],t=>{const f=fixture(t),m=meta(f,'invalid-preflight');for(const value of invalid){const before=f.state.listReceipts();invalidError(()=>f.state.recordDirectPostPreflight(m,value));assert.deepEqual(f.state.listReceipts(),before);}});
test(names[7],t=>{for(const [i,value]of values.entries()){const f=fixture(t),m=meta(f,'record-'+i);assert.equal(f.state.beginDirectPostPart(m).claimed,true);const attempt=f.state.directPostRows(m.requestId).find(r=>r.kind==='direct-post-attempt');const result=f.state.recordDirectPostOutcome(m.requestId,m.attemptId,value);assertStoredEventBytes(f.state,f.state.directPostRows(m.requestId).find(r=>r.kind==='direct-post-outcome'),{...attempt.detail,outcome:value});assert.equal(result.outcome,value);assert.equal(result.requestId,m.requestId);assert.equal(result.attemptId,m.attemptId);}});
test(names[8],t=>{const f=fixture(t),m=meta(f,'invalid-record');f.state.beginDirectPostPart(m);for(const value of invalid){const before=f.state.listReceipts();invalidError(()=>f.state.recordDirectPostOutcome(m.requestId,m.attemptId,value));assert.deepEqual(f.state.listReceipts(),before);}});
test(names[9],t=>{for(const [i,[value,count,expected]]of [['bogus',1,true],['unknown',1,true],['sent',1,false],['sent',2,true],['not_sent',2,false]].entries()){const f=fixture(t),m=meta(f,'projection-'+i,count);f.state.beginDirectPostPart(m);const attempt=f.state.directPostRows(m.requestId)[0];f.state.receipt(null,'direct-post-outcome',{...attempt.detail,outcome:value});assert.equal(f.state.hasUnresolvedBindingPost('channel'),expected);}});
test(names[10],t=>{for(const value of [null,false,true,0,42,'','bogus','claimed','in_flight',[],{}]){const f=openPublication(t);f.state.recordTownHallPublicationOutcome(f.key,f.attempt,'not_sent');const row=pub.parsedPublicationRows(f.state,f.key).find(r=>r.detail.event==='outcome');f.state.db.prepare('UPDATE receipts SET detail=? WHERE id=?').run(JSON.stringify({...row.detail,outcome:value}),row.id);const before=f.state.listReceipts();pub.assertCorrupt(()=>f.state.getTownHallPublication(f.key));assert.deepEqual(f.state.listReceipts(),before);pub.assertCorrupt(()=>f.state.reserveTownHallPublication(f.key));assert.deepEqual(f.state.listReceipts(),before);}});
test(names[11],t=>{for(const value of values){const f=openPublication(t);const prior=pub.parsedPublicationRows(f.state,f.key).find(r=>r.detail.event==='in_flight');const result=f.state.recordTownHallPublicationOutcome(f.key,f.attempt,value,value==='sent'?{messageId:'message'}:{});assert.equal(result.status,value);assert.equal(result.attemptId,f.attempt);assertStoredEventBytes(f.state,pub.parsedPublicationRows(f.state,f.key).find(r=>r.detail.event==='outcome'),{...prior.detail,event:'outcome',outcome:value,messageId:value==='sent'?'message':null});}const f=openPublication(t);for(const value of invalid){const before=f.state.listReceipts();pub.assertBindingError(()=>f.state.recordTownHallPublicationOutcome(f.key,f.attempt,value),'town-hall publication outcome is invalid');assert.deepEqual(f.state.listReceipts(),before);}});
function membershipConsultation(site, verdict) {
  const cached = new Map(Object.entries(require.cache).filter(([key]) => key.startsWith(wt + path.sep)));
  const cleanup = [];
  const context = { after: fn => cleanup.push(fn) };
  let active = false, consultations = 0, descriptor, contracts;
  try {
    for (const key of cached.keys()) delete require.cache[key];
    contracts = require(path.join(wt, 'dist/state/direct-post/contracts.js'));
    descriptor = Object.getOwnPropertyDescriptor(contracts, 'isDirectPostOutcome');
    contracts.isDirectPostOutcome = value => {
      if (!active) return contracts.DIRECT_POST_OUTCOMES.includes(value);
      consultations++;
      assert.equal(value, site.startsWith('publication') ? 'not_sent' : 'sent');
      return site === 'projectionSecond' && consultations === 1 ? true : verdict;
    };
    const { fixture } = require(path.join(wt, 'test/direct-post-fixture.js'));
    const pub = require(path.join(wt, 'test/town-hall-publication-scenarios-fixtures.cjs'));
    const state = require(path.join(wt, 'src/state.js'));
    let f, act, expectedError, expectedResult;
    if (site.startsWith('publication')) {
      f = pub.fixture(context);
      const key = f.state.createTownHallBroadcast(pub.input()).broadcast.journalKey;
      const attempt = f.state.reserveTownHallPublication(key).publication.attemptId;
      f.state.markTownHallPublicationInFlight(key, attempt);
      if (site === 'publicationDecode') {
        f.state.recordTownHallPublicationOutcome(key, attempt, 'not_sent');
        act = () => f.state.getTownHallPublication(key).status;
        expectedError = e => e instanceof state.StateCorruptError && e.message === 'town-hall publication journal is corrupt';
      } else {
        act = () => f.state.recordTownHallPublicationOutcome(key, attempt, 'not_sent').status;
        expectedError = e => e instanceof state.BindingError && e.message === 'town-hall publication outcome is invalid';
      }
      expectedResult = 'not_sent';
    } else {
      f = fixture(context);
      const m = meta(f, site);
      if (site === 'preflight') act = () => f.state.recordDirectPostPreflight(m, 'sent').outcome;
      else {
        f.state.beginDirectPostPart(m);
        if (site === 'outcome') act = () => f.state.recordDirectPostOutcome(m.requestId, m.attemptId, 'sent').outcome;
        else {
          const attempt = f.state.directPostRows(m.requestId)[0];
          f.state.receipt(null, 'direct-post-outcome', { ...attempt.detail, outcome: 'sent' });
          act = () => f.state.hasUnresolvedBindingPost('channel');
        }
      }
      expectedError = e => e instanceof state.BindingError && e.message === 'invalid direct post outcome';
      expectedResult = site.startsWith('projection') ? !verdict : 'sent';
    }
    const before = f.state.listReceipts();
    active = true;
    let returned, thrown;
    try { returned = act(); } catch (error) { thrown = error; }
    const after = f.state.listReceipts();
    const refusal = !verdict && !site.startsWith('projection');
    const row = { site, verdict, consultations, returned, thrown: thrown?.message };
    const verify = () => {
      assert.equal(consultations, site === 'projectionSecond' ? 2 : (site === 'projectionFirst' || site === 'publicationRecord') && verdict ? 2 : 1, site + ' predicate consultation count');
      if (refusal) {
        assert.ok(thrown && expectedError(thrown), 'membership refusal');
        assert.deepEqual(after, before, 'refusal preserves every receipt');
      } else {
        assert.equal(thrown, undefined, 'unexpected refusal');
        assert.equal(returned, expectedResult, 'predicate verdict controls behavior');
        if (site.startsWith('projection') || site === 'publicationDecode') assert.deepEqual(after, before);
      }
    };
    return { row, verify };
  } finally {
    if (contracts) {
      if (descriptor) Object.defineProperty(contracts, 'isDirectPostOutcome', descriptor);
      else delete contracts.isDirectPostOutcome;
    }
    for (const key of Object.keys(require.cache)) if (key.startsWith(wt + path.sep)) delete require.cache[key];
    for (const [key, loaded] of cached) require.cache[key] = loaded;
    const cleanupErrors = [];
    for (const close of cleanup.reverse()) {
      try { close(); } catch (error) { cleanupErrors.push(error); }
    }
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'fixture cleanup failed');
  }
}

function assertOwnership(snapshots,relocated,sourceRoot='/reference/src') {
 assert.equal(predicateDefinitions(snapshots['state/direct-post/contracts.ts']),1,'single contracts predicate definition');
 const found=Object.entries(snapshots).filter(([file])=>file!=='state/direct-post/contracts.ts').flatMap(([file,text])=>detect(text,path.join(sourceRoot,file)));
 assert.equal(found.length,0,'private full-domain membership decisions');
 const expected={'direct-post.ts':{outcomeFor:1},'state/direct-post.ts':{hasUnresolvedBindingPost:2,recordDirectPostPreflight:1,recordDirectPostOutcome:1},'state/town-hall-publication/repository.ts':relocated?{recordTownHallPublicationOutcome:1}:{canonicalEvent:1,recordTownHallPublicationOutcome:1}};
 if(relocated)expected['state/town-hall-publication/journal.ts']={canonicalEvent:1};
 assert.deepEqual(inventory(snapshots),expected);
}
test(names[12],async t=>{
 const journal='src/state/town-hall-publication/journal.ts';const relocated=fs.existsSync(path.join(wt,journal))&&declaresFunction(fs.readFileSync(path.join(wt,journal),'utf8'),'canonicalEvent');
 const sourceRoot=path.join(wt,'src');const snapshots=collectSourceSnapshots(sourceRoot);
 assertOwnership(snapshots,relocated,sourceRoot);assert.equal(typeof contracts.isDirectPostOutcome,'function');
 for(const site of ['preflight','outcome','projectionFirst','projectionSecond','publicationDecode','publicationRecord'])for(const verdict of [true,false])membershipConsultation(site,verdict).verify();
 const original=Object.getOwnPropertyDescriptor(contracts,'isDirectPostOutcome');
 try{for(const verdict of [true,false]){let forced=0;const real=original.value;contracts.isDirectPostOutcome=value=>{if(forced===0){forced++;assert.equal(value,'sent');return verdict;}return real(value);};await transport(t,['sent'],verdict?'sent':'unknown');assert.equal(forced,1);}}
 finally{Object.defineProperty(contracts,'isDirectPostOutcome',original);}
});
test(names[13],t=>{
 const owner='state/direct-post/contracts.ts';
 const snapshot={
  [owner]:"export function isDirectPostOutcome(x){return typeof x==='string';}",
  'direct-post.ts':"import {isDirectPostOutcome} from './state/direct-post/contracts'; function outcomeFor(x){return isDirectPostOutcome(x);}",
  'state/direct-post.ts':"import {isDirectPostOutcome} from './direct-post/contracts'; function hasUnresolvedBindingPost(x,y){if(!isDirectPostOutcome(x))return true;if(!isDirectPostOutcome(y))return true;return false;}function recordDirectPostPreflight(x){return isDirectPostOutcome(x);}function recordDirectPostOutcome(x){return isDirectPostOutcome(x);}",
  'state/town-hall-publication/repository.ts':"import {isDirectPostOutcome} from '../direct-post/contracts'; function canonicalEvent(x){return isDirectPostOutcome(x);}function decodePublication(x){return canonicalEvent(x);}function recordTownHallPublicationOutcome(x){return state.transaction(()=>{if(!isDirectPostOutcome(x))throw Error('invalid');return x;});}"
 };
 const header="import {DIRECT_POST_OUTCOMES as domain} from './state/direct-post/contracts'; ";
 snapshot['direct-post.ts']+='\n'+header+"function legacyTransfers(s,b,id,allowLegacyChildRoute,agentThreadId){legacyParentSourcedReceipt(s,b,id,Object.values(domain),false,b.channelId);legacyParentSourcedReceipt(s,b,id,Object.values(domain),allowLegacyChildRoute,agentThreadId);legacyParentSourcedReceipt(s,b,id,Object.values(domain),allowLegacyChildRoute,null);}function subset(x){return ['sent','unknown'].includes(x);}";
 assertOwnership(snapshot,false);
 const mutations=[
  'function extra(x){return Object.values(domain).includes(x);}',
  'const alias=domain;function extra(x){return alias.includes(x);}',
  'const alias=Object.freeze('+JSON.stringify(values)+');function extra(x){return alias.includes(x);}',
  'const alias=new Set(Object.values(domain));function extra(x){return alias.has(x);}',
  'function extra(x){return '+values.map(v=>'x==='+JSON.stringify(v)).join('||')+';}',
  'function extra(x){switch(x){'+values.map(v=>'case '+JSON.stringify(v)+':').join('')+'return true;default:return false;}}'
 ];
 const completeRegex='^(sent|not_sent|rejected|rate_limited|unknown|stale)$';
 const loopRegexControls=[
  ['function extra(x){let found=false;for(const value of '+JSON.stringify(values)+'){if(value===x){found=true;break}}for(found of [false]){}return found}',0],
  ['function extra(x){let found=false;for(const value of '+JSON.stringify(values)+'){if(value===x){found=true;break}}for(found in {reset:true}){}return found}',0],
  ['function extra(x){let found=false;for(const value of '+JSON.stringify(values)+'){if(value===x){found=true;break}}for({found} of [{found:false}]){}return found}',0],
  ['function extra(x){let found=false;for(const value of '+JSON.stringify(values)+'){if(value===x){found=true;break}}const decision=found;for(found of [false]){}return decision}',1],
  ['function extra(x){let found=false;for(const value of '+JSON.stringify(values)+'){if(value===x){found=true;break}}for(const other of [false]){}return found}',1],
  ['function extra(x){let found=false;for(const value of '+JSON.stringify(values)+'){if(value===x){found=true;break}}({state:found}={state:false});return found}',0],
  ['function extra(x){let found=false;for(const value of '+JSON.stringify(values)+'){if(value===x){found=true;break}}const decision=found;({found}={found:false});return decision}',1],
  ['function extra(x){var found=false;for(const value of '+JSON.stringify(values)+'){if(value===x){found=true;break}}var found=false;return found}',0],
  ['function extra(x){let found=false;for(const value of '+JSON.stringify(values)+'){if(value===x){found=true;break}}[found]=[false];return found}',0],
  ['function extra(x){let found=false;for(const value of '+JSON.stringify(values)+'){if(value===x){found=true;break}}({found}={found:false});return found}',0],
  ['function extra(x){let found=false;for(const value of '+JSON.stringify(values)+'){if(value===x){found=true;break}}const decision=found;[found]=[false];return decision}',1],
  ['const re=/'+completeRegex+'/;const method="compile";re[method]("^(sent|unknown)$");function subset(x){return re.test(x)}',0],
  ['const re=/'+completeRegex+'/;const method="compile";const alias=method;re[alias]("^(sent|unknown)$");function subset(x){return re.test(x)}',0],
  ['const re=/'+completeRegex+'/;const method="test";function extra(x){return re[method](x)}',1],
  ['function extra(x){let found=false;for(const value of '+JSON.stringify(values)+'){if(value===x){found=true;break}}found=false;return found}',0],
  ['function extra(x){let found=false;for(const value of '+JSON.stringify(values)+'){if(value===x){found=true;break}}const decision=found;return decision}',1],
  ['function extra(x){let found=false;for(const value of '+JSON.stringify(values)+'){if(value===x){found=true;break}}const decision=found;found=false;return decision}',1],
  ['function extra(x){let found=false;const decision=found;for(const value of '+JSON.stringify(values)+'){if(value===x){found=true;break}}return decision}',0],
  ['function extra(x){let found=false;for(const value of '+JSON.stringify(values)+'){if(value===x){found=true;break}}let decision=found;decision=false;return decision}',0],
  ['function extra(x){return RegExp(/'+completeRegex+'/).test(x)}',1],
  ['const original=/'+completeRegex+'/;const alias=original;function extra(x){return new RegExp(alias).test(x)}',1],
  ['function subset(x){return RegExp(/^(sent|unknown)$/).test(x)}',0],
  ['const re=/'+completeRegex+'/;re["compile"]("^(sent|unknown)$");function subset(x){return re.test(x)}',0],
  ['const re=/'+completeRegex+'/;const alias=re;alias["compile"]("^(sent|unknown)$");function subset(x){return re.test(x)}',0],
  ['function extra(x){let found=false;for(const value of '+JSON.stringify(values)+'){if(value===x){found=true;break}}return found}',1],
  ['function log(x){let found=false;for(const value of '+JSON.stringify(values)+'){if(value===x){found=true;break}}console.log(found)}',0],
  ['function subset(x){let found=false;for(const value of ["sent","unknown"]){if(value===x){found=true;break}}return found}',0],
  ['function extra(x){for(const value of '+JSON.stringify(values)+'){const searched=x;if(value===searched)return true}return false}',1],
  ['function constant(){for(const value of '+JSON.stringify(values)+'){const searched="sent";if(value===searched)return true}return false}',0],
  ['function extra(x){return RegExp('+JSON.stringify(completeRegex)+').test(x)}',1],
  ['function shadow(RegExp,x){return RegExp('+JSON.stringify(completeRegex)+').test(x)}',0],
  ['const re=/'+completeRegex+'/;re.compile("^(sent|unknown)$");function subset(x){return re.test(x)}',0],
  ['const re=/'+completeRegex+'/;const alias=re;alias.compile("^(sent|unknown)$");function subset(x){return re.test(x)}',0],
  ['function extra(x){for(const value of '+JSON.stringify(values)+'){if(value===x)return true;}return false;}',1],
  ['function extra(x){for(const value of domain){if(x.outcome===value)return true;}return false;}',1],
  ['function subset(x){for(const value of ["sent","unknown"]){if(value===x)return true;}return false;}',0],
  ['function log(x){for(const value of '+JSON.stringify(values)+'){if(value===x)console.log(value);}}',0],
  ['function constant(){for(const value of '+JSON.stringify(values)+'){if(value==="sent")return true;}return false;}',0],
  ['function extra(x){return /'+completeRegex+'/.test(x);}',1],
  ['const re=/'+completeRegex+'/;const alias=re;function extra(x){return alias.test(x.outcome);}',1],
  ['const holder={re:/'+completeRegex+'/};function extra(x){return holder.re["test"](x);}',1],
  ['function extra(x){return new RegExp('+JSON.stringify(completeRegex)+').exec(x);}',1],
  ['function subset(x){return /^(sent|unknown)$/.test(x);}',0],
  ['function constant(){return /'+completeRegex+'/.test("sent");}',0],
  ['function shadow(RegExp,x){return new RegExp('+JSON.stringify(completeRegex)+').test(x);}',0],
  ['let re=/'+completeRegex+'/;re=/sent/;function changed(x){return re.test(x);}',0]
 ];
 for(const [text,count] of loopRegexControls){assert.equal(detect(header+text).length,count,'full vocabulary loop and regex decisions');}
 for(const [text,count] of loopRegexControls){if(count)mutations.push(text);}
 const goldenInventory=inventory(snapshot);
 const predicateImport="import {isDirectPostOutcome} from './state/direct-post/contracts';";
 const delegationControls=[
  [predicateImport+"namespace Unused {export function outcomeFor(x){return isDirectPostOutcome(x);}}",0],
  [predicateImport+"function helper(x){const unused={outcomeFor(y){return isDirectPostOutcome(y);}};return x;}",0],
  [predicateImport+"function helper(x){function outcomeFor(y){return isDirectPostOutcome(y);}return x;}",0],
  [predicateImport+"function helper(x){return queue(function outcomeFor(y){return isDirectPostOutcome(y);});}",0],
  [predicateImport+"function outcomeFor(x){return (()=>!isDirectPostOutcome(x))();}",1],
  [predicateImport+"function outcomeFor(x){return (()=>isDirectPostOutcome(x)?x:'unknown')();}",1],
  [predicateImport+"function outcomeFor(x){function outcomeFor(y){return isDirectPostOutcome(y);}return x;}",0],
  [predicateImport+"function outcomeFor(x){return (function invoked(){return isDirectPostOutcome(x);})();}",1],
  [predicateImport+"function outcomeFor(x){return state.transaction(function invoked(){return isDirectPostOutcome(x);});}",1],
  [predicateImport+"function outcomeFor(x){return (()=>isDirectPostOutcome(x))();}",1],
  [predicateImport+"function outcomeFor(x){const unused=()=>{return isDirectPostOutcome(x);};return x;}",0],
  [predicateImport+"function outcomeFor(x){const unused=function(){return isDirectPostOutcome(x);};return x;}",0],
  [predicateImport+"function outcomeFor(x){return (()=>{return isDirectPostOutcome(x);})();}",1],
  [predicateImport+"function outcomeFor(x){return state.transaction(()=>{if(!isDirectPostOutcome(x))throw Error('invalid');return x;});}",1],
  [predicateImport+"function outcomeFor(x){return queue(()=>{return isDirectPostOutcome(x);});}",0],
  [predicateImport+"function outcomeFor(x){function unused(){return isDirectPostOutcome(x);}return x;}",0],
  ["import {shared} from './predicate-barrel';function outcomeFor(x){return shared(x)?x:'unknown';}",0,predicateImport+"export let shared=isDirectPostOutcome;shared=()=>true;"],
  [predicateImport+"function outcomeFor(x){const ok=isDirectPostOutcome(x);if(!ok)return 'unknown';return x;}",1],
  [predicateImport+"function outcomeFor(x){const ok=isDirectPostOutcome(x);const alias=ok;return alias?x:'unknown';}",1],
  ["import * as contract from './state/direct-post/contracts';function outcomeFor(x){return contract.isDirectPostOutcome(x)?x:'unknown';}",1],
  ["import {isDirectPostOutcome as shared} from './predicate-barrel';function outcomeFor(x){return shared(x)?x:'unknown';}",1],
  [predicateImport+"const shared=isDirectPostOutcome;function outcomeFor(x){return shared(x)?x:'unknown';}",1],
  [predicateImport+"function outcomeFor(x){const unused=isDirectPostOutcome(x);return x;}",0],
  [predicateImport+"function outcomeFor(x){let ok=isDirectPostOutcome(x);ok=false;return ok?x:'unknown';}",0],
  [predicateImport+"let shared=isDirectPostOutcome;shared=()=>true;function outcomeFor(x){return shared(x)?x:'unknown';}",0],
  ["import * as contract from './state/direct-post/contracts';const alias=contract;alias.isDirectPostOutcome=()=>true;function outcomeFor(x){return alias.isDirectPostOutcome(x)?x:'unknown';}",0],
  [predicateImport+"function outcomeFor(x,isDirectPostOutcome){return isDirectPostOutcome(x)?x:'unknown';}",0],
  [predicateImport+"function outcomeFor(x){const ok=isDirectPostOutcome(x);function unused(){return ok;}return x;}",0],
  [predicateImport+"function outcomeFor(x){let a=b;let b=a;return a?x:'unknown';}",0]
 ];
 for(const [text,count,barrel="export {isDirectPostOutcome} from './state/direct-post/contracts';"] of delegationControls){
  const candidate={...snapshot,'direct-post.ts':text,'predicate-barrel.ts':barrel};
  assert.equal(inventory(candidate)['direct-post.ts'].outcomeFor||0,count,'shared predicate delegation decision use');
 }
 for(const [factory,count] of [
  ["namespace Unused {export function createDirectPostHandlers(){return {recordDirectPostPreflight(x){return isDirectPostOutcome(x);}};}}",0],
  ["function unused(){function createDirectPostHandlers(){return {recordDirectPostPreflight(x){return isDirectPostOutcome(x);}};}return {};}",0],
  ["function createDirectPostHandlers(){const handlers={recordDirectPostPreflight(x){return isDirectPostOutcome(x);}};return handlers;}",1],
  ["function createDirectPostHandlers(){const handlers={recordDirectPostPreflight(x){return isDirectPostOutcome(x);}};return {};}",0],
  ["function unrelated(){const handlers={recordDirectPostPreflight(x){return isDirectPostOutcome(x);}};return handlers;}",0]
 ]){
  const candidate={...snapshot,'state/direct-post.ts':"import {isDirectPostOutcome} from './direct-post/contracts';"+factory};
  assert.equal(inventory(candidate)['state/direct-post.ts'].recordDirectPostPreflight||0,count,'returned handler factory delegation');
 }
 for(const mutation of mutations){
  const candidate={...snapshot,'direct-post.ts':snapshot['direct-post.ts']+'\n'+mutation};
  assert.deepEqual(inventory(candidate),goldenInventory,'seven valid calls preserved in each mutant');
  assert.equal(predicateDefinitions(candidate[owner]),1,'owner remains present');
  assert.throws(()=>assertOwnership(candidate,false),/private full-domain membership decisions/);
 }
 const relocated={...snapshot,'state/town-hall-publication/repository.ts':"import {isDirectPostOutcome} from '../direct-post/contracts';function recordTownHallPublicationOutcome(x){return isDirectPostOutcome(x);}",'state/town-hall-publication/journal.ts':"import {isDirectPostOutcome} from '../direct-post/contracts';function canonicalEvent(x){return isDirectPostOutcome(x);}function decodePublication(x){return canonicalEvent(x);}"};
 assertOwnership(relocated,true);
 const duplicate={...snapshot,[owner]:snapshot[owner]+"function nested(){const isDirectPostOutcome=()=>true;}"};
 assert.throws(()=>assertOwnership(duplicate,false),/single contracts predicate definition/);
 const sourceRoot=fs.mkdtempSync(path.join(os.tmpdir(),'outcome-inventory-discovery-'));
 t.after(()=>fs.rmSync(sourceRoot,{recursive:true,force:true}));
 for(const [file,text]of Object.entries(snapshot)){
  const filename=path.join(sourceRoot,file);fs.mkdirSync(path.dirname(filename),{recursive:true});fs.writeFileSync(filename,text);
 }
 const discover=()=>collectSourceSnapshots(sourceRoot);
 assertOwnership(discover(),false,sourceRoot);
 const malformed='const broken = ; function accepted(x){return true}';
 for(const parse of [()=>detect(malformed,path.join(sourceRoot,'broken.ts')),()=>inventory({'broken.ts':malformed}),()=>predicateDefinitions(malformed),()=>declaresFunction(malformed,'accepted')]) {
  assert.throws(parse,/source inventory refuses parse errors/);
 }
 fs.writeFileSync(path.join(sourceRoot,'malformed-sibling.ts'),malformed);
 assert.throws(()=>assertOwnership(discover(),false,sourceRoot),/source inventory refuses parse errors/);
 fs.unlinkSync(path.join(sourceRoot,'malformed-sibling.ts'));
 const requireClassifiers=[
  "const domain=require('./state/direct-post/contracts').DIRECT_POST_OUTCOMES;function extra(x){return domain.includes(x);}",
  "const contracts=require('./state/direct-post/contracts');function extra(x){return Object.values(contracts.DIRECT_POST_OUTCOMES).includes(x);}",
  "const {DIRECT_POST_OUTCOMES:domain}=require('./state/direct-post/contracts');function extra(x){return domain.includes(x);}"
 ];
 for(const [index,text]of requireClassifiers.entries()){
  const file='required-classifier-'+index+'.ts';fs.writeFileSync(path.join(sourceRoot,file),text);
  const found=discover();assert.ok(Object.hasOwn(found,file));assert.deepEqual(inventory(found),goldenInventory);
  assert.equal(detect(found[file],path.join(sourceRoot,file)).length,1);
  assert.throws(()=>assertOwnership(found,false,sourceRoot),/private full-domain membership decisions/);
  fs.unlinkSync(path.join(sourceRoot,file));
 }
 assert.equal(detect("function extra(require,x){const domain=require('./state/direct-post/contracts').DIRECT_POST_OUTCOMES;return domain.includes(x);}",path.join(sourceRoot,'shadowed.ts')).length,0);
 assert.equal(detect("const domain=require('./state/direct-post/contracts').DIRECT_POST_OUTCOMES;function transfer(fn){return fn(domain);}function subset(x){return ['sent','unknown'].includes(x);}",path.join(sourceRoot,'transfers.ts')).length,0);
 const localDomain = 'const domain='+JSON.stringify(values)+';';
 const objectDomain = 'const codes='+JSON.stringify(Object.fromEntries(values.map((value,index)=>['v'+index,value])))+';';
 const semanticClassifiers = [
  objectDomain+'function extra(x){return '+values.map((_,index)=>'x===codes.v'+index).join('||')+';}',
  localDomain+'function extra(input){return '+values.map(value=>'input.value==='+JSON.stringify(value)).join('||')+';}',
  objectDomain+'function extra(x){return Object.values(codes).includes(x);}',
  localDomain+'const holder={outcomes:new Set(domain)};function extra(x){return holder.outcomes.has(x);}',
  localDomain+'const copy=[...domain];function extra(x){return copy.includes(x);}',
  'const domain=new Map('+JSON.stringify(values.map(value=>[value,true]))+');function extra(x){return domain.has(x);}',
  objectDomain+'function extra(x){switch(x){'+values.map((_,index)=>'case codes.v'+index+':').join('')+'return true;default:return false;}}',
  ...['indexOf','some','find'].map(method=>localDomain+'function extra(x){return domain.'+method+'('+(method==='indexOf'?'x':'value=>value===x')+')'+(method==='indexOf'?'>=0':'')+';}'),
  localDomain+'function extra(x){return domain["includes"](x);}'
 ];
 for(const text of semanticClassifiers) assert.equal(detect(text).length,1,text);
 assert.equal(detect(localDomain+'function transfer(fn){return fn([...domain]);}').length,0);
 assert.equal(detect(localDomain+'function transfer(){return domain.find(value=>value);}').length,0);
 assert.equal(detect(localDomain+'function unrelated(){return domain.some(value=>true);}').length,0);
 assert.equal(detect(localDomain+'function ordinal(){return domain.indexOf("unknown");}').length,0);
 for(const method of ['some','find']) {
  assert.equal(detect(localDomain+'function transfer(){return domain.'+method+'(value=>value===value);}').length,0);
  assert.equal(detect(localDomain+'function subset(){return domain.'+method+'(value=>value==="sent");}').length,0);
 }
 assert.equal(detect(localDomain+'function extra(x){return domain.some((value,index)=>value===x);}').length,1);
 assert.equal(detect(localDomain+'domain.splice(1);function subset(x){return domain.includes(x);}').length,0);
 assert.equal(detect('let domain='+JSON.stringify(values)+';domain=["sent","unknown"];function subset(x){return domain.includes(x);}').length,0);
 assert.equal(detect('const codes={a:"sent",b:"unknown"};function subset(x){return Object.values(codes).includes(x);}').length,0);
 assert.equal(detect(localDomain+'const alias=domain;alias.splice(1);function subset(x){return domain.includes(x);}').length,0);
 assert.equal(detect(localDomain+'const alias=domain;const second=alias;second.splice(1);function subset(x){return alias.includes(x);}').length,0);
 assert.equal(detect(localDomain+'function unrelated(){return domain.some((value,index)=>value===index);}').length,0);
 assert.equal(detect(localDomain+'function unrelated(){return domain.find((value,index)=>value===index.value);}').length,0);
 assert.equal(detect(localDomain+'function vocabulary(){return domain.indexOf("unknown")>=0;}').length,0);
 assert.equal(detect(localDomain+'function extra(x){return -1!==domain.indexOf(x);}').length,1);
 assert.equal(detect(localDomain+'function extra(x){return 0<=domain.indexOf(x);}').length,1);
 assert.equal(detect(localDomain+'function extra(x){return -1<domain.indexOf(x);}').length,1);
 for(const method of ['some','find']) assert.equal(detect(localDomain+'function unrelated(){return domain.'+method+'((value,index)=>value===domain[index]);}').length,0);
 assert.equal(detect(localDomain+'let alias=domain;alias=["sent"];function extra(x){return domain.includes(x);}').length,1);
 assert.equal(detect(localDomain+'let alias=domain;alias=["sent"];function subset(x){return alias.includes(x);}').length,0);
 for(const extension of ['js','ts','cjs','mjs','mts','cts','tsx','jsx']){
  const file='new-private-classifier.'+extension;
  fs.writeFileSync(path.join(sourceRoot,file),'const domain='+JSON.stringify(values)+';function extra(x){return domain.includes(x);}');
  const found=discover();assert.ok(Object.hasOwn(found,file),'new sibling discovered');
  assert.deepEqual(inventory(found),goldenInventory,'existing delegations preserved');
  assert.throws(()=>assertOwnership(found,false,sourceRoot),/private full-domain membership decisions/);
  fs.unlinkSync(path.join(sourceRoot,file));
 }
 fs.writeFileSync(path.join(sourceRoot,'transfer.js'),'const domain='+JSON.stringify(values)+';function transfer(fn){return fn(domain);}');
 fs.writeFileSync(path.join(sourceRoot,'subset.mjs'),"function subset(x){return ['sent','unknown'].includes(x);}");
 assertOwnership(discover(),false,sourceRoot);
 fs.appendFileSync(path.join(sourceRoot,owner),'\nexport const DIRECT_POST_OUTCOMES='+JSON.stringify(values)+';');
 fs.writeFileSync(path.join(sourceRoot,'re-export-types.ts'),"export {DIRECT_POST_OUTCOMES} from './state/direct-post/contracts';");
 const reexport='new-reexported-classifier.ts';
 fs.writeFileSync(path.join(sourceRoot,reexport),"import {DIRECT_POST_OUTCOMES} from './re-export-types';function extra(x){return Object.values(DIRECT_POST_OUTCOMES).includes(x);}");
 assert.equal(detect(discover()[reexport],path.join(sourceRoot,reexport)).length,1,'actual-path re-export detected');
 assert.throws(()=>assertOwnership(discover(),false,sourceRoot),/private full-domain membership decisions/);
 fs.unlinkSync(path.join(sourceRoot,reexport));
 assertOwnership(discover(),false,sourceRoot);
 const generatedRoot=path.join(sourceRoot,'dist/state/direct-post');
 fs.mkdirSync(generatedRoot,{recursive:true});
 for(const extension of ['js','cjs']) fs.writeFileSync(path.join(generatedRoot,'contracts.'+extension),'exports.DIRECT_POST_OUTCOMES='+JSON.stringify(values)+';');
 fs.writeFileSync(path.join(sourceRoot,'exported-vocabulary.ts'),'export const known='+JSON.stringify(values)+';');
 fs.writeFileSync(path.join(sourceRoot,'exported-subset.ts'),'export const known=["sent","unknown"];');
 fs.appendFileSync(path.join(sourceRoot,owner),'\nexport const subset=["sent","unknown"];');
 fs.writeFileSync(path.join(sourceRoot,'exported-barrel.ts'),"export * as vocabulary from './exported-vocabulary';");
 const provenanceControls=[
  ["import * as vocabulary from './state/direct-post/contracts';function subset(x){return vocabulary.subset.includes(x);}",0],
  ["import * as vocabulary from './state/direct-post/contracts';function subset(x){return vocabulary.missing.includes(x);}",0],
  ["import * as vocabulary from './exported-vocabulary';let alias=vocabulary;alias={known:['sent']};function subset(x){return alias.known.includes(x);}",0],
  ["import * as vocabulary from './exported-vocabulary';const alias=vocabulary;alias.known=['sent'];function subset(x){return alias.known.includes(x);}",0],
  ["const {known}=require('./exported-vocabulary');function extra(x){return known.includes(x);}",1],
  ["const list=require('./exported-vocabulary');function extra(x){return list.known.includes(x);}",1],
  ["function extra(x){return require('./exported-vocabulary').known.includes(x);}",1],
  ["const {known}=require('./exported-subset');function subset(x){return known.includes(x);}",0],
  ["const list=require('./exported-subset');function subset(x){return list.known.includes(x);}",0],
  ["function subset(x){return require('./exported-subset').known.includes(x);}",0],
  ["import * as vocabulary from './exported-vocabulary';function extra(x){return vocabulary.known.includes(x);}",1],
  ["import * as vocabulary from './exported-vocabulary';const alias=vocabulary;function extra(x){return alias.known.includes(x);}",1],
  ["import {vocabulary} from './exported-barrel';function extra(x){return vocabulary.known.includes(x);}",1],
  ["import * as vocabulary from './exported-subset';function subset(x){return vocabulary.known.includes(x);}",0],
  ["const domain=require('./dist/state/direct-post/contracts.js').DIRECT_POST_OUTCOMES;function extra(x){return domain.includes(x);}",1],
  ["const {DIRECT_POST_OUTCOMES:domain}=require('./dist/state/direct-post/contracts.cjs');function extra(x){return domain.includes(x);}",1],
  ["import * as owner from './dist/state/direct-post/contracts.js';function extra(x){return Object.values(owner.DIRECT_POST_OUTCOMES).includes(x);}",1],
  ["import {known as domain} from './exported-vocabulary';function extra(x){return domain.includes(x);}",1],
  ["import {known as domain} from './exported-subset';function subset(x){return domain.includes(x);}",0],
  ["function subset(require,x){const domain=require('./dist/state/direct-post/contracts.js').DIRECT_POST_OUTCOMES;return domain.includes(x);}",0]
 ];
 for(const [text,count] of provenanceControls) assert.equal(detect(text,path.join(sourceRoot,'provenance.ts')).length,count,'generated and exported vocabulary provenance');
 for(const extension of ['js','cjs','mjs']){
  const actualFile=path.join(wt,'src','provenance.'+extension);
  const facade="const {DIRECT_POST_OUTCOMES:domain}=require('../dist/state/direct-post.js');function extra(x){return domain.includes(x);}";
  assert.equal(detect(facade,actualFile).length,1,'actual built facade export detected');
  assert.equal(detect("function subset(require,x){const {DIRECT_POST_OUTCOMES:domain}=require('../dist/state/direct-post.js');return domain.includes(x);}",actualFile).length,0,'shadowed facade require excluded');
 }
 const link=path.join(sourceRoot,'alias.js');fs.symlinkSync(path.join(sourceRoot,'transfer.js'),link);
 assert.throws(discover,/source inventory rejects symlinks/);fs.unlinkSync(link);
 assert.doesNotThrow(()=>detect(fs.readFileSync(path.join(wt,'src/state.js'),'utf8'),path.join(wt,'src/state.js')),'actual JavaScript parses');

});
