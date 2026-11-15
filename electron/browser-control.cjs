'use strict';
const net = require('node:net');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

async function startBrowserControl({ win, client, dataDir }) {
  const guests = new Map();
  const loads = new Map();
  const failures = new Map();
  win.webContents.on('did-attach-webview', (_event, guest) => {
    guests.set(guest.id, guest);
    loads.set(guest.id, 0);
    guest.on('did-start-loading', () => { loads.set(guest.id, (loads.get(guest.id) || 0) + 1); failures.delete(guest.id); });
    guest.on('did-fail-load', (_event, code, description, _url, isMainFrame) => { if (isMainFrame && code !== -3) failures.set(guest.id, description); });
    guest.once('destroyed', () => { guests.delete(guest.id); loads.delete(guest.id); failures.delete(guest.id); });
  });
  const token = crypto.randomBytes(32).toString('hex');
  const name = `winmux-ui-${crypto.createHash('sha256').update(path.resolve(dataDir)).digest('hex').slice(0,24)}`;
  const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : path.join(dataDir, 'ui.sock');
  const endpoint = path.join(dataDir, 'ui-control.json');
  function select(id) {
    const guest = id === undefined && guests.size === 1 ? guests.values().next().value : guests.get(Number(id));
    if (!guest || guest.isDestroyed()) throw new Error('Supply a browser id from open; the target must still be open.');
    return guest;
  }
  async function request(method, params = {}) {
    if (method === 'open') {
      const url = new URL(params.url);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('HTTP(S) URL without credentials required');
      const state = await client.request('state');
      const workspaceId = params.workspaceId || state.settings.activeWorkspaceId || state.workspaces[0]?.id;
      if (!state.workspaces.some(item => item.id === workspaceId)) throw new Error('Create a workspace before opening its browser');
      const before = new Map(loads);
      win.webContents.send('winmux:event', { type: 'browser-open', workspaceId, url: url.href });
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const id = await win.webContents.executeJavaScript(`(() => { const panel = [...document.querySelectorAll('[data-testid="workspace-tools"]')].find(el => el.dataset.workspaceId === ${JSON.stringify(workspaceId)}); const view = [...(panel?.querySelectorAll('webview') || [])].find(el => el.getClientRects().length > 0); try { return view?.getWebContentsId(); } catch { return null; } })()`);
        const guest = guests.get(id);
        if (guest && !guest.isDestroyed() && guest.getURL() && !guest.isLoading() && (guest.getURL() === url.href || (loads.get(id) || 0) > (before.get(id) || 0))) {
          if (failures.has(id)) throw new Error(`Page failed to load: ${failures.get(id)}`);
          return { id, workspaceId, url: guest.getURL(), title: guest.getTitle() };
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error('Browser did not finish opening within 15 seconds');
    }
    if (method === 'list') return [...guests.values()].map(guest => ({ id: guest.id, url: guest.getURL(), title: guest.getTitle() }));
    const guest = select(params.id);
    if (method === 'snapshot') return guest.executeJavaScript(`(() => {
      document.querySelectorAll('[data-winmux-ref]').forEach(el => el.removeAttribute('data-winmux-ref'));
      const elements = [...document.querySelectorAll('a,button,input,textarea,select,[role="button"],[contenteditable="true"]')].filter(el => el.getClientRects().length).slice(0,300).map((el,index) => {
        const ref = 'e' + index; el.setAttribute('data-winmux-ref',ref);
        return {ref,tag:el.tagName.toLowerCase(),name:el.getAttribute('aria-label') || el.innerText?.trim().slice(0,160) || el.getAttribute('placeholder') || '',type:el.getAttribute('type'),disabled:!!el.disabled};
      });
      return {url:location.href,title:document.title,text:document.body.innerText.slice(0,40000),elements};
    })()`);
    if (method === 'click' || method === 'fill') {
      if (!params.selector && !/^e\d+$/.test(params.ref || '')) throw new Error('Supply a selector or ref from snapshot');
      const selector = params.selector || `[data-winmux-ref="${params.ref}"]`;
      return guest.executeJavaScript(`(() => {
        const matches=document.querySelectorAll(${JSON.stringify(selector)});
        if(matches.length!==1) throw new Error('Target must match exactly one element');
        const el=matches[0]; if(!el.getClientRects().length || el.disabled) throw new Error('Target is hidden or disabled');
        el.focus();
        if(${JSON.stringify(method)} === 'click') el.click();
        else {
          const value=${JSON.stringify(String(params.value ?? ''))};
          if(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
            const proto=el instanceof HTMLInputElement?HTMLInputElement.prototype:el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLSelectElement.prototype;
            Object.getOwnPropertyDescriptor(proto,'value').set.call(el,value);
          } else if(el.isContentEditable) el.textContent=value;
          else throw new Error('Target is not editable');
          el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true}));
        }
        return {ok:true};
      })()`, true);
    }
    if (method === 'evaluate') {
      if (typeof params.expression !== 'string' || params.expression.length > 100000) throw new Error('Supply a JavaScript expression under 100 KB');
      return guest.executeJavaScript(params.expression, true);
    }
    if (method === 'screenshot') {
      const directory = path.join(dataDir, 'captures'); await fs.mkdir(directory, { recursive:true });
      const file = path.join(directory, `${Date.now()}-${guest.id}.png`);
      await fs.writeFile(file, (await guest.capturePage()).toPNG());
      return { path:file };
    }
    throw new Error(`Unknown browser operation: ${method}`);
  }
  let queue = Promise.resolve();
  const sockets = new Set();
  const server = net.createServer(socket => {
    if (sockets.size >= 16) { socket.destroy(); return; }
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    socket.setTimeout(25000, () => socket.destroy());
    let buffer = ''; socket.setEncoding('utf8');
    socket.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 1024 * 1024) { socket.destroy(); return; }
      const newline = buffer.indexOf('\n'); if (newline < 0) return;
      socket.removeAllListeners('data');
      let message;
      try {
        message = JSON.parse(buffer.slice(0,newline));
        if (typeof message.token !== 'string' || message.token.length !== token.length || !crypto.timingSafeEqual(Buffer.from(message.token),Buffer.from(token))) throw new Error('Unauthorized');
      } catch (error) { socket.end(JSON.stringify({error:error.message})+'\n'); return; }
      const operation = queue.then(async () => {
        if (socket.destroyed) throw new Error('Caller disconnected before execution');
        let timer;
        try { return await Promise.race([request(message.method, message.params), new Promise((_,reject) => {
          timer = setTimeout(() => reject(new Error('Operation timed out; inspect the page before retrying')), 20000);
        })]); } finally { clearTimeout(timer); }
      });
      queue = operation.catch(() => {});
      operation.then(result => {
        const response = JSON.stringify({result});
        if (Buffer.byteLength(response) > 4 * 1024 * 1024) throw new Error('Browser response exceeds 4 MB');
        socket.end(response+'\n');
      }).catch(error => { if (!socket.destroyed) socket.end(JSON.stringify({error:error.message})+'\n'); });
    });
  });
  await new Promise((resolve,reject) => { server.once('error',reject); server.listen(pipe,resolve); });
  await fs.writeFile(endpoint, JSON.stringify({pipe,token}), {mode:0o600});
  return { close() { for (const socket of sockets) socket.destroy(); server.close(); fs.unlink(endpoint).catch(()=>{}); } };
}
module.exports = { startBrowserControl };
