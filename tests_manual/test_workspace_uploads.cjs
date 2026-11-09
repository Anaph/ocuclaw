const assert=require('node:assert/strict');
const {createWorkspaceUploads}=require('../dist-cjs/runtime/workspace-uploads.cjs');
let now=1000;const uploads=createWorkspaceUploads(()=>now);
const file=Buffer.alloc(180000,17);
const {id}=uploads.request('a','uploads.begin',{size:file.length,fileName:'Доклад.pdf',mimeType:'application/pdf'});
assert.throws(()=>uploads.request('b','uploads.chunk',{id,offset:0,content:'YQ=='}),/upload_not_found/);
assert.throws(()=>uploads.take('a',[id]),/upload_incomplete/);
for(let at=0;at<file.length;at+=65536)uploads.request('a','uploads.chunk',{id,offset:at,content:file.subarray(at,at+65536).toString('base64')});
assert.throws(()=>uploads.request('a','uploads.chunk',{id,offset:0,content:'YQ=='}),/invalid_upload_chunk/);
const pending=uploads.request('a','uploads.begin',{size:1,fileName:'pending.txt',mimeType:'text/plain'});
assert.throws(()=>uploads.take('a',[id,pending.id]),/upload_incomplete/);
assert.deepEqual(Buffer.from(uploads.take('a',[id])[0].content,'base64'),file);
assert.throws(()=>uploads.take('a',[id]),/upload_not_found/);
assert.throws(()=>uploads.request('a','uploads.begin',{size:1,fileName:'../../private',mimeType:'text/plain'}),/invalid_attachment/);
for(let i=0;i<uploads.limits.files-1;i++)
 uploads.request('a','uploads.begin',{size:1,fileName:'new.txt',mimeType:'text/plain'});
now+=300001;assert.throws(()=>uploads.take('a',[pending.id]),/upload_not_found/);
uploads.close();console.log('test_workspace_uploads OK');
