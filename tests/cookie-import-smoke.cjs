'use strict';
const assert=require('node:assert/strict');
const {normalizeCookies}=require('../electron/cookie-import.cjs');
const input={cookies:[
 {name:'session',value:'fixture-only',domain:'.example.test',path:'/',httpOnly:true,secure:true,sameSite:'None',expirationDate:Math.floor(Date.now()/1000)+600},
 {name:'host',value:'local',domain:'app.example.test',hostOnly:true,path:'/app',secure:true,sameSite:'Lax'},
 {name:'unrelated',value:'skip',domain:'other.test',path:'/'},
 {name:'expired',value:'skip',domain:'app.example.test',expirationDate:1},
 {name:'partitioned',value:'skip',domain:'app.example.test',partitionKey:{topLevelSite:'https://example.test'}},
 {name:'invalid\nname',value:'skip',domain:'app.example.test'},
]};
const result=normalizeCookies(input,'https://app.example.test');
assert.equal(result.accepted.length,2);assert.equal(result.skipped,4);
assert.equal(result.accepted[0].sameSite,'no_restriction');assert.equal(result.accepted[0].httpOnly,true);
assert.equal(result.accepted[0].domain,'.example.test');assert.equal(result.accepted[1].domain,undefined);
assert.equal(normalizeCookies(input,'http://app.example.test').accepted.length,0);
assert.throws(()=>normalizeCookies(input,'file:///secret'),/HTTP/);
assert.throws(()=>normalizeCookies(input,'https://user:pass@example.test'),/HTTP/);
assert.throws(()=>normalizeCookies({},'https://example.test'),/array/);
for (const scope of [
 {domain:'app.example.test',hostOnly:true,domainCookie:false},
 {domain:'.app.example.test',hostOnly:true,domainCookie:false},
 {domain:'app.example.test',domainCookie:false},
 {domain:'app.example.test',hostOnly:false,domainCookie:true},
 {domain:'.app.example.test',domainCookie:true},
]) {
 for (const host of ['app.example.test','child.app.example.test','sibling.example.test','example.test','otherapp.example.test']) {
  const {domainCookie,...cookie}=scope;
  const target=`https://${host}`;
  const normalized=normalizeCookies([{...cookie,name:'scoped',value:'fixture-only',path:'/app'}],target);
  const matches=host==='app.example.test' || (domainCookie && host==='child.app.example.test');
  assert.equal(normalized.accepted.length,Number(matches),JSON.stringify({cookie,host}));
  assert.equal(normalized.skipped,Number(!matches));
  if (matches) {
   assert.equal(normalized.accepted[0].url,target+'/app');
   assert.equal(normalized.accepted[0].path,'/app');
   assert.equal(normalized.accepted[0].domain,domainCookie ? cookie.domain : undefined);
  }
 }
}
console.log('COOKIE_NORMALIZATION_OK: domain filtering, host-only, expiry, SameSite, partition rejection, invalid input');
