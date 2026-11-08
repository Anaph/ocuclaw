const assert=require('node:assert/strict');
const {createWorkspaceService}=require('../dist-cjs/runtime/workspace-service.cjs');
const {createHermesGatewayBridge}=require('../dist-cjs/runtime/hermes-gateway-bridge.cjs');
const {createDownstreamHandler}=require('../dist-cjs/runtime/downstream-handler.cjs');
(async()=>{
 const calls=[];
 const {bridge}=createHermesGatewayBridge({link:{request:async(method,params)=>{calls.push({method,params});return {status:'accepted'};}}});
 const service=createWorkspaceService({bridge,sessions:{},send(){}});
 const frame={type:'ocuclaw.workspace.request',version:1,id:'request-1',method:'inbox.answer',params:{id:'q1',sessionKey:'hermes:main:a',operationId:'op1',answer:{text:'Да'}}};
 const handler=createDownstreamHandler({onWorkspaceRequest:(id,f)=>service.request(id,f)});
 const result=await handler.handleMessage('app1',JSON.stringify(frame));
 assert.equal(JSON.parse(result.unicast).data.status,'accepted');
 assert.equal(calls[0].method,'inbox.answer');
 assert.equal(calls[0].params.id,'q1');
 assert.equal(calls[0].params.sessionKey,'hermes:main:a');
 const unsupported=await service.request('app1',{...frame,method:'gw.hermes.management'});
 assert.equal(JSON.parse(unsupported.unicast).data.error,'unsupported_operation');
 const invalid=await service.request('app1',{...frame,version:9});
 assert.equal(JSON.parse(invalid.unicast).data.error,'invalid_request');
 assert.equal(calls.length,1);
 service.close();
 console.log('test_workspace_emu OK');
})().catch(e=>{console.error(e);process.exit(1)});

(async()=>{
 const calls=[];
 const {bridge}=createHermesGatewayBridge({link:{request:async(method,params)=>{calls.push({method,params});return method==='db.sessions.list'?{sessions:[]}:{status:'accepted'};}}});
 const sessions={getSessionPin:()=>({pinned:false}),setSessionPinned:(kind,key,pinned)=>({ok:true,kind,key,pinned}),createDetachedSessionKey:()=> 'hermes:main:new'};
 const service=createWorkspaceService({bridge,sessions,send(){}});
 const request=async(method,params={})=>JSON.parse((await service.request('app',{version:1,id:'1',method,params})).unicast).data;
 assert.equal((await request('sessions.create')).key,'hermes:main:new');
 assert.equal((await request('sessions.pin',{key:'hermes:main:a',pinned:true})).pinned,true);
 assert.equal((await request('sessions.list')).sessions.length,0);
 const rejected=await request('sessions.abort',{key:'hermes:main:x:desktop:external'});
 assert.ok(rejected.error);
 assert.equal(calls.filter(c=>c.method==='sessions.abort').length,0);
 service.close();
 console.log('test_workspace_session_boundaries OK');
})().catch(e=>{console.error(e);process.exitCode=1});
