const assert=require('node:assert/strict');
const {createSessionService}=require('../dist-cjs/runtime/session-service.cjs');
const {createWorkspaceService}=require('../dist-cjs/runtime/workspace-service.cjs');
const {createHermesGatewayBridge}=require('../dist-cjs/runtime/hermes-gateway-bridge.cjs');
(async()=>{
 const calls=[],events=[];
 const {bridge,dispatchBackendEvent}=createHermesGatewayBridge({link:{request:async(method,params)=>{calls.push({method,params});if(method==='db.chat.history')return {messages:[]};if(method==='gw.profiles.list')return {profiles:[{name:'default'},{name:'research'}]};if(method==='workspace.models')return {models:[{id:'test-model',provider:'custom'}]};if(method==='sessions.options.apply')return {status:'unsupported'};return {status:'accepted',runId:'run'};}}});
 const sessions=createSessionService({gatewayBridge:bridge,defaultSessionKeyPrefix:'hermes:main:',sessionKeyPrefixForAgentRef:ref=>`hermes:${ref==='default'?'main':ref||'main'}:`});
 const service=createWorkspaceService({bridge,sessions,send:(id,data)=>events.push({id,data})});
 const request=async(id,method,params={})=>JSON.parse((await service.request(id,{version:1,id:'request',method,params})).unicast).data;
 assert.ok((await request('a','sessions.create',{profileId:'research',model:'test-model',provider:'custom'})).key.startsWith('hermes:research:'));assert.equal(sessions.peekSessionKey(),null);
 const model=calls.find(x=>x.method==='dispatch.send'&&x.params.message.startsWith('/model'));
 assert.match(model.params.message,/--session$/);assert.equal(model.params.target.ns,'research');
 await request('a','chat.subscribe',{sessionKey:'hermes:main:a'});await request('b','chat.subscribe',{sessionKey:'hermes:main:b'});
 dispatchBackendEvent('streaming',{sessionKey:'hermes:main:a',runId:'run-a',seq:1,text:'Русский ответ'});
 assert.deepEqual(events.map(x=>x.id),['a']);assert.equal(events[0].data.data.text,'Русский ответ');
 await request('a','agent',{sessionKey:'hermes:main:a',message:'Задача',idempotencyKey:'send-id'});
 assert.equal(calls.at(-1).params.workspaceOperationId,'send-id');
 await request('a','workspace.send.receipt',{sessionKey:'hermes:main:a',operationId:'send-id'});assert.equal(calls.at(-1).method,'workspace.send.receipt');assert.deepEqual(calls.at(-1).params.target,{ns:'main',chatId:'a'});
 const denied=await request('a','agent',{sessionKey:'hermes:main:a',message:'x',attachments:[{path:'/private'}]});assert.equal(denied.error,'use_authenticated_uploads');
 assert.equal((await request('a','agent',{sessionKey:'hermes:main:a',message:'x'})).error,'invalid_operation_id');
 service.disconnect('a');dispatchBackendEvent('streaming',{sessionKey:'hermes:main:a',text:'After disconnect'});assert.equal(events.length,1);
 service.close();console.log('test_workspace_phone OK');
})().catch(error=>{console.error(error);process.exitCode=1;});

(async () => {
 const readers = [], events = [];
 let stream;
 const service = createWorkspaceService({
   bridge: {
     request: () => new Promise(resolve => readers.push(resolve)),
     on(event, listener) { if (event === 'streaming') stream = listener; },
   },
   send: (_, event) => events.push(event.data.sessionKey),
 });
 const request = (method, sessionKey) =>
   service.request('phone', { version: 1, id: 'req', method, params: { sessionKey } });
 const old = request('chat.subscribe', 'hermes:main:a');
 const latest = request('chat.subscribe', 'hermes:main:b');
 readers[1]({ messages: [] });
 await latest;
 readers[0]({ messages: [] });
 await old;
 stream({ sessionKey: 'hermes:main:a' });
 stream({ sessionKey: 'hermes:main:b' });
 const closing = request('chat.subscribe', 'hermes:main:c');
 await request('chat.unsubscribe');
 readers[2]({ messages: [] });
 await closing;
 stream({ sessionKey: 'hermes:main:c' });
 assert.deepEqual(events, ['hermes:main:b']);
 service.close();
})().catch(error => { console.error(error); process.exitCode = 1; });

(async () => {
 const listeners = new Map();
 const frames = [];
 let finishHistory;
 const service = createWorkspaceService({
   bridge: {
     on(name, listener) {
       listeners.set(name, listener);
       return () => listeners.delete(name);
     },
     request: () => new Promise((resolve) => { finishHistory = resolve; }),
   },
   send: (_, event) => frames.push(event),
 });
 try {
   const sessionKey = 'hermes:main:a';
   const request = () => service.request('phone', {
     version: 1, id: 'subscribe', method: 'chat.subscribe', params: { sessionKey },
   });
   const first = request();
   const live = { sessionKey, runId: 'run', seq: 7, text: 'Partial reply' };
   listeners.get('streaming')(live);
   finishHistory({ messages: [] });
   assert.deepEqual(JSON.parse((await first).unicast).data.live, live);
   listeners.get('activity')({ sessionKey, runId: 'run', phase: 'error' });
   listeners.get('streaming')({ ...live, seq: 8 });
   const second = request();
   finishHistory({ messages: [] });
   assert.equal(JSON.parse((await second).unicast).data.live, null);
   assert.equal(frames[0].event, 'activity');
   console.log('test_workspace_live_resume OK');
 } finally {
   service.close();
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
