'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const run = promisify(execFile);
const TEXT_LIMIT = 512 * 1024;
const IMAGE_LIMIT = 12 * 1024 * 1024;
const IMAGE_TYPES = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.bmp', 'image/bmp'],
  ['.ico', 'image/x-icon'],
  ['.avif', 'image/avif'],
  ['.svg', 'image/svg+xml'],
]);

function invalid(message) {
  const error = new Error(message);
  error.code = 'INVALID_FILE_PATH';
  throw error;
}

function validateInput(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) {
    invalid('Provide a local file path without control characters');
  }
  const input = value.trim();
  if (/^(?:javascript|data|https?):/i.test(input)) invalid('Only local files can be previewed');
  const remotePath = (candidate) => candidate.replace(/\\/g, '/').startsWith('//');
  if (remotePath(input)) invalid('UNC and remote paths are not supported');

  if (/^file:/i.test(input)) {
    let url;
    try { url = new URL(input); } catch { invalid('Invalid local file URL'); }
    if (url.protocol !== 'file:' || !['', 'localhost'].includes(url.hostname) || url.username || url.password) {
      invalid('Only local file URLs are supported');
    }
    if (url.search || url.hash) invalid('File URLs cannot contain query strings or fragments');
    let decoded;
    try { decoded = decodeURIComponent(url.pathname); } catch { invalid('Invalid local file URL encoding'); }
    if (/[\x00-\x1f\x7f]/.test(decoded)) invalid('Provide a local file path without control characters');
    if (remotePath(decoded)) invalid('UNC and remote paths are not supported');
    if (/^\/[A-Za-z]:[\\/]/.test(decoded)) decoded = decoded.slice(1).replace(/\//g, '\\');
    return { input:decoded, absolute:/^(?:[A-Za-z]:[\\/]|\/)/.test(decoded) };
  }

  if (/^[A-Za-z]:[\\/]/.test(input)) return { input, absolute:true };
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(input)) invalid('Only local files can be previewed');
  return { input, absolute:path.isAbsolute(input) };
}

function workspaceContext(state, paneId, workspaceId) {
  if (workspaceId !== undefined && (typeof workspaceId !== 'string' || !workspaceId)) invalid('Invalid workspaceId');
  let pane;
  if (paneId !== undefined && paneId !== null) {
    if (typeof paneId !== 'string' || !paneId) invalid('Invalid paneId');
    for (const workspace of state.workspaces || []) {
      const found = (workspace.panes || []).find(item => item.id === paneId);
      if (found) {
        if (workspaceId && workspace.id !== workspaceId) invalid('Pane does not belong to this workspace');
        pane = found;
        workspaceId = workspace.id;
        break;
      }
    }
    if (!pane) invalid('Terminal pane is closed');
  }
  const explicitWorkspace = workspaceId ? (state.workspaces || []).find(item => item.id === workspaceId) : undefined;
  if (workspaceId && !explicitWorkspace) invalid('Workspace is closed');
  const workspace = explicitWorkspace
    || (!paneId ? (state.workspaces || []).find(item => item.id === state.settings?.activeWorkspaceId) : undefined)
    || (!paneId ? state.workspaces?.[0] : undefined);
  if (!workspace) invalid('Open a workspace before previewing a file');
  return {
    workspaceId:workspace.id,
    paneId:pane?.id,
    cwd:pane?.cwd || workspace.cwd,
    profileId:pane?.profileId || workspace.profileId,
  };
}

async function boundedRead(file, limit) {
  const handle = await fs.open(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(limit + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function describePreview(fullPath, size, data) {
  const name = path.basename(fullPath);
  const mime = IMAGE_TYPES.get(path.extname(name).toLowerCase());
  if (mime) {
    if (size > IMAGE_LIMIT || data.length > IMAGE_LIMIT) throw new Error('Preview image limit is 12 MB');
    return { name, path:fullPath, kind:'image', mime, size, dataUrl:`data:${mime};base64,${data.toString('base64')}` };
  }
  const sample = data.subarray(0, 8192);
  if (sample.includes(0)) return { name, path:fullPath, kind:'binary', size };
  return {
    name,
    path:fullPath,
    kind:'text',
    size,
    text:data.subarray(0, TEXT_LIMIT).toString('utf8'),
    truncated:size > TEXT_LIMIT || data.length > TEXT_LIMIT,
  };
}

async function readWindowsFile(input) {
  const requested = path.resolve(input.absolute ? input.input : path.resolve(input.cwd, input.input));
  let fullPath;
  try { fullPath = await fs.realpath(requested); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error(`File not found: ${requested}`);
    throw error;
  }
  const stat = await fs.stat(fullPath);
  if (!stat.isFile()) throw new Error('Select a file to preview, not a directory');
  const mime = IMAGE_TYPES.get(path.extname(fullPath).toLowerCase());
  const data = await boundedRead(fullPath, mime ? IMAGE_LIMIT : TEXT_LIMIT);
  return describePreview(fullPath, stat.size, data);
}

const WSL_READER = String.raw`import base64,json,os,sys
root,value=sys.argv[1],os.path.expanduser(sys.argv[2])
target=os.path.realpath(value if os.path.isabs(value) else os.path.join(root,value))
if not os.path.isfile(target):
 raise ValueError('Select a file to preview, not a directory')
size=os.path.getsize(target)
images={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.bmp':'image/bmp','.ico':'image/x-icon','.avif':'image/avif','.svg':'image/svg+xml'}
mime=images.get(os.path.splitext(target)[1].lower())
if mime:
 if size>12*1024*1024: raise ValueError('Preview image limit is 12 MB')
 with open(target,'rb') as handle: data=handle.read(12*1024*1024+1)
 result={'kind':'image','mime':mime,'dataUrl':'data:'+mime+';base64,'+base64.b64encode(data).decode('ascii')}
else:
 with open(target,'rb') as handle: data=handle.read(512*1024+1)
 if data[:8192].find(b'\0')>=0: result={'kind':'binary'}
 else: result={'kind':'text','text':data[:512*1024].decode('utf-8','replace'),'truncated':size>512*1024 or len(data)>512*1024}
result.update(name=os.path.basename(target),path=target,size=size)
print(json.dumps(result,separators=(',',':')))`;

async function readWslFile(input, profile, cwd) {
  try {
    const { stdout } = await run('wsl.exe', ['-d', profile.distro, '--', 'python3', '-c', WSL_READER, cwd, input.input], {
      windowsHide:true,
      timeout:20000,
      maxBuffer:20 * 1024 * 1024,
      encoding:'utf8',
    });
    return JSON.parse(stdout);
  } catch (error) {
    const detail = (error.stderr || error.message || '').trim().slice(0, 1200);
    throw new Error(`Cannot preview WSL file; python3 is required. ${detail}`);
  }
}

async function readFilePreview({ client, path:value, paneId, workspaceId }) {
  const input = validateInput(value);
  const state = await client.request('state', {});
  const context = workspaceContext(state, paneId, workspaceId);
  const environment = await client.request('environment', {});
  const profile = environment.profiles.find(item => item.id === context.profileId);
  if (!profile) invalid('Terminal profile is unavailable');

  const windowsPath = /^[A-Za-z]:[\\/]/.test(input.input);
  const result = windowsPath || profile.environment !== 'wsl'
    ? await readWindowsFile({ ...input, cwd:context.cwd })
    : await readWslFile(input, profile, context.cwd);
  return { ...result, workspaceId:context.workspaceId, paneId:context.paneId };
}

function previewMetadata(result) {
  return {
    name:result.name,
    path:result.path,
    kind:result.kind,
    size:result.size,
    workspaceId:result.workspaceId,
    paneId:result.paneId,
  };
}

module.exports = { readFilePreview, previewMetadata, validateInput, TEXT_LIMIT, IMAGE_LIMIT };
