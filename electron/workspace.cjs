const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const workspaceMethods = new Set(['files.list','files.read','files.write','git.status','git.diff']);
const LIMIT = 12 * 1024 * 1024;
const imageTypes = {'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.bmp':'image/bmp','.ico':'image/x-icon','.avif':'image/avif','.svg':'image/svg+xml'};
function relative(value='') {
  if (typeof value!=='string' || value.length>4096 || /[\x00-\x1f]/.test(value)) throw new Error('Invalid path');
  const normalized=value.replace(/\\/g,'/');
  if (normalized.startsWith('/') || normalized.includes(':') || normalized.split('/').some(p=>p==='..')) throw new Error('Path must remain inside the current directory');
  return normalized.replace(/^\.\//,'');
}
async function context(client, params) {
  if (!params || typeof params.workspaceId!=='string') throw new Error('Workspace is required');
  const state=await client.request('state',{});
  const workspace=state.workspaces.find(w=>w.id===params.workspaceId);
  if(!workspace) throw new Error('Workspace is closed');
  let target=workspace;
  if(params.paneId!==undefined){
    if(typeof params.paneId!=='string')throw new Error('Invalid paneId');
    const pane=workspace.panes?.find(p=>p.id===params.paneId);
    if(!pane)throw new Error('Pane does not belong to this workspace');
    target={...workspace,cwd:pane.cwd,profileId:pane.profileId};
  }
  const env=await client.request('environment',{});
  const profile=env.profiles.find(p=>p.id===target.profileId);
  if(!profile) throw new Error('Terminal profile is unavailable');
  return {workspace:target,profile};
}
async function resolveLocal(root, rel, allowMissing=false) {
  const actualRoot=await fs.realpath(root);
  let candidate=path.resolve(actualRoot,relative(rel)), target;
  while(true){
    try {target=await fs.realpath(candidate);break;}
    catch(error){
      if(!allowMissing || error.code!=='ENOENT' || path.dirname(candidate)===candidate)throw error;
      candidate=path.dirname(candidate);
    }
  }
  const fromRoot=path.relative(actualRoot,target);
  if(fromRoot==='..' || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot)) throw new Error('Link points outside the current directory');
  return target;
}
async function entryType(root,target,entry) {
  if(entry.isDirectory()) return 'directory';
  if(!entry.isSymbolicLink()) return 'file';
  try {
    const resolved=await fs.realpath(path.join(target,entry.name));
    const fromRoot=path.relative(root,resolved);
    if(fromRoot==='..' || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot)) return 'symlink';
    return (await fs.stat(resolved)).isDirectory() ? 'directory' : 'symlink';
  } catch { return 'symlink'; }
}
function preview(buffer,name,size) {
  const mime=imageTypes[path.extname(name).toLowerCase()];
  if(mime) return {kind:'image',dataUrl:`data:${mime};base64,${buffer.toString('base64')}`,size};
  if(buffer.subarray(0,8192).includes(0)) return {kind:'binary',size};
  return {kind:'text',text:buffer.subarray(0,512*1024).toString('utf8'),size,truncated:size>512*1024};
}
async function localFiles(root,method,rel,params) {
  const target=await resolveLocal(root,rel);
  if(method==='files.list') {
    const all=await fs.readdir(target,{withFileTypes:true});
    const actualRoot=await fs.realpath(root);
    const entries=await Promise.all(all.filter(e=>e.name!=='.git').map(async e=>({name:e.name,type:await entryType(actualRoot,target,e)})));
    entries.sort((a,b)=>Number(b.type==='directory')-Number(a.type==='directory') || a.name.localeCompare(b.name));
    return {path:rel,entries:entries.slice(0,2000).map(e=>({name:e.name,path:rel?`${rel}/${e.name}`:e.name,type:e.type,size:0})),truncated:entries.length>2000};
  }
  const stat=await fs.stat(target);
  if(!stat.isFile()) throw new Error('Select a file to preview');
  if(method==='files.write') {
    if(stat.size>512*1024) throw new Error('Only complete UTF-8 text files can be edited');
    const handle=await fs.open(target,'r+');
    try {
      const data=await handle.readFile();
      if(data.length>512*1024 || imageTypes[path.extname(rel).toLowerCase()] || data.includes(0) || !Buffer.from(data.toString('utf8')).equals(data)) throw new Error('Only complete UTF-8 text files can be edited');
      if(data.toString('utf8')!==params.expectedText) throw new Error('File changed on disk. Reopen it before saving.');
      const output=Buffer.from(params.text,'utf8');
      for(let offset=0;offset<output.length;) {
        const {bytesWritten}=await handle.write(output,offset,output.length-offset,offset);
        if(!bytesWritten) throw new Error('File write made no progress');
        offset+=bytesWritten;
      }
      await handle.truncate(Buffer.byteLength(params.text));
    } finally { await handle.close(); }
    return localFiles(root,'files.read',rel);
  }
  if(stat.size>LIMIT) throw new Error('Preview limit is 12 MB');
  return {path:rel,...preview(await fs.readFile(target),rel,stat.size)};
}
const pythonFiles = String.raw`import os,sys,json,base64,mimetypes
root=os.path.realpath(os.path.expanduser(sys.argv[1])); rel=sys.argv[2]; method=sys.argv[3]
target=os.path.realpath(os.path.join(root,rel))
if os.path.commonpath([root,target])!=root: raise ValueError('Path is outside workspace')
def contained(candidate):
 return os.path.commonpath([root,candidate])==root
if method=='files.list':
 entries=[]
 with os.scandir(target) as scan:
  for item in scan:
   if item.name=='.git': continue
   kind='symlink' if item.is_symlink() else 'directory' if item.is_dir() else 'file'
   if kind=='symlink':
    resolved=os.path.realpath(item.path)
    if contained(resolved) and os.path.isdir(resolved): kind='directory'
   entries.append(dict(name=item.name,path=(rel+'/' if rel else '')+item.name,type=kind,size=0))
 entries.sort(key=lambda x:(x['type']!='directory',x['name'].lower()))
 print(json.dumps(dict(path=rel,entries=entries[:2000],truncated=len(entries)>2000)))
elif method=='files.write':
 payload=json.load(sys.stdin)
 if os.path.splitext(target)[1].lower() in {'.png','.jpg','.jpeg','.gif','.webp','.bmp','.ico','.avif','.svg'}: raise ValueError('Only complete UTF-8 text files can be edited')
 with open(target,'r+b') as f:
  data=f.read(512*1024+1)
  if len(data)>512*1024 or b'\0' in data: raise ValueError('Only complete UTF-8 text files can be edited')
  try: original=data.decode('utf8')
  except UnicodeDecodeError: raise ValueError('Only complete UTF-8 text files can be edited')
  if original!=payload['expectedText']: raise ValueError('File changed on disk. Reopen it before saving.')
  f.seek(0); f.write(payload['text'].encode('utf8')); f.truncate()
 print(json.dumps(dict(path=rel,kind='text',text=payload['text'],size=len(payload['text'].encode('utf8')),truncated=False)))
else:
 size=os.path.getsize(target)
 if size>12*1024*1024: raise ValueError('Preview limit is 12 MB')
 with open(target,'rb') as f: data=f.read(12*1024*1024+1)
 ext=os.path.splitext(target)[1].lower()
 images={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.bmp':'image/bmp','.ico':'image/x-icon','.avif':'image/avif','.svg':'image/svg+xml'}
 result=dict(path=rel,size=size)
 if ext in images: result.update(kind='image',dataUrl='data:'+images[ext]+';base64,'+base64.b64encode(data).decode())
 elif b'\0' in data[:8192]: result.update(kind='binary')
 else: result.update(kind='text',text=data[:512*1024].decode('utf8',errors='replace'),truncated=size>512*1024)
 print(json.dumps(result))`;
const wslRoots=new Map();
async function linuxRoot(workspace,profile) {
  const key=JSON.stringify([profile.distro,workspace.cwd]);
  if(wslRoots.has(key))return wslRoots.get(key);
  const {stdout}=await run('wsl.exe',['-d',profile.distro,'--','python3','-c','import os,sys;print(os.path.realpath(os.path.expanduser(sys.argv[1])))',workspace.cwd],{windowsHide:true,timeout:12000,maxBuffer:65536,encoding:'utf8'});
  const root=stdout.trim();
  if(!root.startsWith('/'))throw new Error('WSL did not return an absolute directory');
  wslRoots.set(key,root);
  return root;
}
async function executeGit(workspace,profile,args,accepted=[0]) {
  const gitArgs=['--no-optional-locks','--literal-pathspecs','-c','core.quotepath=false','-c','core.pager=cat',...args];
  const wsl=profile.environment==='wsl';
  const root=wsl?await linuxRoot(workspace,profile):workspace.cwd;
  try {
    const result=await run(wsl?'wsl.exe':'git',wsl?['-d',profile.distro,'--','git','-C',root,...gitArgs]:['-C',root,...gitArgs],{windowsHide:true,timeout:12000,maxBuffer:4*1024*1024,encoding:'utf8',env:{...process.env,GIT_TERMINAL_PROMPT:'0',GIT_OPTIONAL_LOCKS:'0'}});
    return result.stdout;
  }catch(error){
    if(accepted.includes(error.code))return error.stdout || '';
    throw new Error((error.stderr || error.message).trim().slice(0,1500));
  }
}
function parseStatus(stdout) {
  const records=stdout.split('\0');
  let branch='';
  const entries=[];
  for(let i=0;i<records.length;i++){
    const record=records[i];
    if(record.startsWith('## ')){branch=record.slice(3);continue;}
    if(record.length<4)continue;
    const entry={path:record.slice(3),index:record[0],worktree:record[1]};
    if(/[RC]/.test(record.slice(0,2)))entry.originalPath=records[++i];
    entries.push(entry);
  }
  return {available:true,branch,entries};
}
async function workspaceRequest(client,method,params) {
  if(!workspaceMethods.has(method))throw new Error('Unknown workspace operation');
  const {workspace,profile}=await context(client,params);
  const rel=relative(params.path);
  if(method==='files.write' && (typeof params.text!=='string' || typeof params.expectedText!=='string' || Buffer.byteLength(params.text)>512*1024 || Buffer.byteLength(params.expectedText)>512*1024 || params.text.includes('\0'))) throw new Error('Only complete UTF-8 text up to 512 KB can be saved');
  if(method.startsWith('files.')){
    if(profile.environment!=='wsl')return localFiles(workspace.cwd,method,rel,params);
    try {
      const operation=run('wsl.exe',['-d',profile.distro,'--','python3','-c',pythonFiles,workspace.cwd,rel,method],{windowsHide:true,timeout:15000,maxBuffer:20*1024*1024,encoding:'utf8'});
      if(method==='files.write') operation.child.stdin.end(JSON.stringify({text:params.text,expectedText:params.expectedText}));
      const {stdout}=await operation;
      return JSON.parse(stdout);
    }catch(error){throw new Error(`Cannot open WSL file; python3 is required in the distribution. ${(error.stderr || error.message).trim().slice(0,1200)}`);}
  }
  if(method==='git.status'){
    try{
      const status=parseStatus(await executeGit(workspace,profile,['status','--porcelain=v1','-z','--branch','--untracked-files=all',...(params.paneId!==undefined?['--','.']:[])]));
      if(params.paneId!==undefined){
        const prefix=(await executeGit(workspace,profile,['rev-parse','--show-prefix'])).replace(/\r?\n$/,'');
        status.entries=status.entries.filter(entry=>entry.path.startsWith(prefix)).map(entry=>{
          const result={...entry,path:entry.path.slice(prefix.length)};
          if(result.originalPath){
            if(result.originalPath.startsWith(prefix))result.originalPath=result.originalPath.slice(prefix.length);
            else delete result.originalPath;
          }
          return result;
        });
      }
      return status;
    }
    catch(error){return {available:false,branch:'',entries:[],error:error.message};}
  }
  const args=['diff','--no-ext-diff','--no-textconv','--no-color'];
  if(params.paneId!==undefined){
    if(profile.environment==='wsl'){
      await run('wsl.exe',['-d',profile.distro,'--','python3','-c','import os,sys; root=os.path.realpath(sys.argv[1]); target=os.path.realpath(os.path.join(root,sys.argv[2])); assert os.path.commonpath([root,target])==root, "Path is outside current directory"',await linuxRoot(workspace,profile),rel],{windowsHide:true,timeout:12000,maxBuffer:65536,encoding:'utf8'});
    }else await resolveLocal(workspace.cwd,rel,true);
    args.push('--relative');
  }
  if(params.staged===true)args.push('--cached');
  args.push('--');if(rel)args.push(rel);else if(params.paneId!==undefined)args.push('.');
  const text=await executeGit(workspace,profile,args);
  if(!text && rel && !params.staged){
    const untracked=await executeGit(workspace,profile,['ls-files','--others','--exclude-standard','--',rel]);
    if(untracked.trim()){
      const file=await workspaceRequest(client,'files.read',{workspaceId:workspace.id,paneId:params.paneId,path:rel});
      return {text:file.kind==='text'?`New file: ${rel}\n\n${file.text}`:`New binary file: ${rel}`};
    }
  }
  return {text};
}
module.exports={workspaceMethods,workspaceRequest,relative,parseStatus};
