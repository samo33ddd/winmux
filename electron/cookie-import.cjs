'use strict';
const fs = require('node:fs/promises');
function normalizeCookies(input, target) {
  const url = new URL(target);
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password) throw new Error('Enter an HTTP(S) site address without credentials.');
  const cookies = Array.isArray(input) ? input : input?.cookies;
  if (!Array.isArray(cookies) || cookies.length > 2000) throw new Error('Expected a JSON cookie array with at most 2000 entries.');
  const accepted = []; let skipped = 0;
  for (const cookie of cookies) {
    const domain = typeof cookie?.domain === 'string' ? cookie.domain.toLowerCase().replace(/^\./,'') : '';
    const domainCookie = cookie?.hostOnly === false || (cookie?.hostOnly !== true && typeof cookie?.domain === 'string' && cookie.domain.startsWith('.'));
    if (!domain || !(url.hostname === domain || (domainCookie && url.hostname.endsWith('.'+domain)))) { skipped++; continue; }
    if (typeof cookie.name !== 'string' || !cookie.name || /[\x00-\x20\x7f()<>@,;:\\"/\[\]?={}]/.test(cookie.name) || typeof cookie.value !== 'string' || cookie.value.length > 4096 || /[\x00\r\n]/.test(cookie.value) || cookie.partitionKey) { skipped++; continue; }
    const secure = cookie.secure === true;
    if (secure && url.protocol !== 'https:') { skipped++; continue; }
    const expires = cookie.expirationDate ?? cookie.expires;
    if (expires !== undefined && expires !== -1 && (!Number.isFinite(expires) || expires <= Date.now()/1000)) { skipped++; continue; }
    const cookiePath = typeof cookie.path === 'string' && cookie.path.startsWith('/') ? cookie.path : '/';
    const sameSite = {none:'no_restriction',no_restriction:'no_restriction',lax:'lax',strict:'strict',unspecified:'unspecified'}[String(cookie.sameSite || 'unspecified').toLowerCase()];
    if (!sameSite || (sameSite === 'no_restriction' && !secure)) { skipped++; continue; }
    accepted.push({url:url.origin+cookiePath,name:cookie.name,value:cookie.value,path:cookiePath,secure,httpOnly:cookie.httpOnly === true,sameSite,
      ...(domainCookie ? {domain:cookie.domain} : {}),
      ...(cookie.session !== true && expires !== undefined && expires !== -1 ? {expirationDate:expires} : {})});
  }
  return {url,accepted,skipped};
}
async function importCookies({dialog,session,win},target) {
  // Check the target before asking the user to select a credential export.
  normalizeCookies([],target);
  const selected = await dialog.showOpenDialog(win,{title:'Import browser cookies',properties:['openFile'],filters:[{name:'Cookie JSON export',extensions:['json']}]});
  if (selected.canceled || !selected.filePaths[0]) return {canceled:true};
  const file = selected.filePaths[0];
  if ((await fs.stat(file)).size > 2 * 1024 * 1024) throw new Error('Cookie export exceeds 2 MB. Export only the selected site.');
  let input;
  try { input = JSON.parse(await fs.readFile(file,'utf8')); } catch { throw new Error('Could not read a valid cookie JSON export.'); }
  const {url,accepted,skipped} = normalizeCookies(input,target);
  if (!accepted.length) return {imported:0,failed:0,skipped,domain:url.hostname};
  const confirmation = await dialog.showMessageBox(win,{type:'question',buttons:['Cancel','Import'],defaultId:0,cancelId:0,message:`Import ${accepted.length} cookies for ${url.hostname}?`,detail:'Matching cookies in the Winmux browser will be replaced. Your external browser is not modified.'});
  if (confirmation.response !== 1) return {canceled:true};
  const store = session.fromPartition('persist:winmux-browser').cookies;
  let imported = 0, failed = 0;
  for (const cookie of accepted) {
    try {
      await store.set(cookie);
      const readback = await store.get({url:cookie.url,name:cookie.name});
      if (readback.some(item => item.value === cookie.value && item.path === cookie.path && item.domain.replace(/^\./,'') === (cookie.domain || new URL(cookie.url).hostname).replace(/^\./,''))) imported++; else failed++;
    } catch { failed++; }
  }
  let persisted = true;
  try { await store.flushStore(); } catch { persisted = false; }
  return {imported,failed,skipped,domain:url.hostname,persisted};
}
module.exports = {normalizeCookies,importCookies};
