import assert from 'node:assert/strict';
import {handleLogin} from '../../worker/index.mjs';
const env = {SECRET_KEY:'test-key'};
const widgetId = '000000000000001';
const forwardedIds = [];
const forwardedBodies = [];
const url='https://example.workers.dev/servicelayer/api/idm/account/soip/login?isocode=IE';
let calls=0;
const upstream=async (target, options)=>{
    assert.equal(target,'https://www.rte.ie/servicelayer/api/idm/account/soip/login?isocode=IE');
    assert.equal(new Headers(options.headers).has('Origin'),false);
    forwardedBodies.push(options.body);
    const forwarded = JSON.parse(options.body).deviceId;
    assert.match(forwarded, /^\d{15}$/);
    forwardedIds.push(forwarded);
    calls++;
    return Response.json(calls===1?{activated:false,associationCode:'TEST01'}:{activated:true,mpx_token:'synthetic-session'});
};
function request(body, key=env.SECRET_KEY, method='POST', origin='null') {
    return new Request(url,{method,headers:{'Content-Type':'application/json','X-RTE-Helper-Key':key,Origin:origin},body:method==='POST'?body:undefined});
}
for(const [r,status] of [
    [request('{}','bad'),403], [request('{'),400],
    [request(JSON.stringify({deviceId:'invalid'})),400],
    [request('x'.repeat(1025)),413], [request('{}',env.SECRET_KEY,'POST','https://example.org'),403]
]) assert.equal((await handleLogin(r,env,upstream)).status,status);
assert.equal(calls,0);
const preflight=await handleLogin(request(null,'','OPTIONS'),env,upstream);
assert.equal(preflight.status,204);
assert.equal(preflight.headers.get('Access-Control-Allow-Origin'),'null');
const pairing=await handleLogin(request(JSON.stringify({deviceId:widgetId})),env,upstream);
assert.equal(pairing.headers.get('Cache-Control'),'no-store');
assert.equal((await pairing.json()).activated,false);
const session=await handleLogin(request(JSON.stringify({deviceId:widgetId})),env,upstream);
assert.deepEqual(await session.json(),{activated:true,mpx_token:'synthetic-session'});
assert.equal(forwardedIds[0], widgetId);
assert.equal(forwardedIds[0], forwardedIds[1]);
await handleLogin(request(JSON.stringify({deviceId:'000000000000002'})),env,upstream);
assert.notEqual(forwardedIds[1], forwardedIds[2]);
await handleLogin(request(JSON.stringify({deviceId:widgetId}),'other-key'),{SECRET_KEY:'other-key'},upstream);
assert.equal(forwardedIds[0], forwardedIds[3]);
const originalBody = ' { \"deviceId\": \"000000000000003\" } ';
await handleLogin(request(originalBody),env,upstream);
assert.equal(forwardedBodies.at(-1), originalBody);
console.log('PASS Worker authentication, original device IDs, storage reset, body limits, CORS and pairing/session forwarding');
