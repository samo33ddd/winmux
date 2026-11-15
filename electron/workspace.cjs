const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const workspaceMethods = new Set(['files.list','files.read','git.status','git.diff']);
const LIMIT = 12 * 1024 * 1024;
const imageTypes = {'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.bmp':'image/bmp','.ico':'image/x-icon','.avif':'image/avif','.svg':'image/svg+xml'};
function relative(value='') {
  if (typeof value!=='string' || value.length>4096 || /[\x00-\x1f]/.test(value)) throw new Error('Некорректный путь');
  const normalized=value.replace(/\\/g,'/');
  if (normalized.startsWith('/') || normalized.includes(':') || normalized.split('/').some(p=>p==='..')) throw new Error('Путь должен находиться внутри проекта');
  return normalized.replace(/^\.\//,'');
}
async function context(client, params) {
  if (!params || typeof params.workspaceId!=='string') throw new Error('Не указано рабочее пространство');
  const state=await client.request('state',{});
  const workspace=state.workspaces.find(w=>w.id===params.workspaceId);
  if(!workspace) throw new Error('Рабочее пространство уже закрыто');
  const env=await client.request('environment',{});
  const profile=env.profiles.find(p=>p.id===workspace.profileId);
  if(!profile) throw new Error('Профиль запуска недоступен');
  return {workspace,profile};
}
async function resolveLocal(root, rel) {
  const actualRoot=await fs.realpath(root);
  const target=await fs.realpath(path.resolve(actualRoot,relative(rel)));
  const fromRoot=path.relative(actualRoot,target);
  if(fromRoot==='..' || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot)) throw new Error('Ссылка ведёт за пределы проекта');
  return target;
}
function preview(buffer,name,size) {
  const mime=imageTypes[path.extname(name).toLowerCase()];
  if(mime) return {kind:'image',dataUrl:`data:${mime};base64,${buffer.toString('base64')}`,size};
  if(buffer.subarray(0,8192).includes(0)) return {kind:'binary',size};
  return {kind:'text',text:buffer.subarray(0,512*1024).toString('utf8'),size,truncated:size>512*1024};
}
async function localFiles(root,method,rel) {
  const target=await resolveLocal(root,rel);
  if(method==='files.list') {
    const all=await fs.readdir(target,{withFileTypes:true});
    const entries=all.filter(e=>e.name!=='.git').sort((a,b)=>Number(b.isDirectory())-Number(a.isDirectory()) || a.name.localeCompare(b.name));
    return {path:rel,entries:entries.slice(0,2000).map(e=>({name:e.name,path:rel?`${rel}/${e.name}`:e.name,type:e.isDirectory()?'directory':e.isSymbolicLink()?'symlink':'file',size:0})),truncated:entries.length>2000};
  }
  const stat=await fs.stat(target);
  if(!stat.isFile()) throw new Error('Выбери файл для просмотра');
  if(stat.size>LIMIT) throw new Error('Предпросмотр ограничен файлами до 12 МБ');
  return {path:rel,...preview(await fs.readFile(target),rel,stat.size)};
}
const pythonFiles = String.raw`import os,sys,json,base64,mimetypes
root=os.path.realpath(os.path.expanduser(sys.argv[1])); rel=sys.argv[2]; method=sys.argv[3]
target=os.path.realpath(os.path.join(root,rel))
if os.path.commonpath([root,target])!=root: raise ValueError('Path is outside workspace')
if method=='files.list':
 entries=[]
 with os.scandir(target) as scan:
  for item in scan:
   if item.name=='.git': continue
   kind='symlink' if item.is_symlink() else 'directory' if item.is_dir() else 'file'
   entries.append(dict(name=item.name,path=(rel+'/' if rel else '')+item.name,type=kind,size=0))
 entries.sort(key=lambda x:(x['type']!='directory',x['name'].lower()))
 print(json.dumps(dict(path=rel,entries=entries[:2000],truncated=len(entries)>2000)))
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
  if(!root.startsWith('/'))throw new Error('WSL не вернул каталог проекта');
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
  if(!workspaceMethods.has(method))throw new Error('Неизвестная операция');
  const {workspace,profile}=await context(client,params);
  const rel=relative(params.path);
  if(method.startsWith('files.')){
    if(profile.environment!=='wsl')return localFiles(workspace.cwd,method,rel);
    try {
      const {stdout}=await run('wsl.exe',['-d',profile.distro,'--','python3','-c',pythonFiles,workspace.cwd,rel,method],{windowsHide:true,timeout:15000,maxBuffer:20*1024*1024,encoding:'utf8'});
      return JSON.parse(stdout);
    }catch(error){throw new Error(`Не удалось открыть файл WSL. Требуется python3 в дистрибутиве. ${(error.stderr || error.message).trim().slice(0,1200)}`);}
  }
  if(method==='git.status'){
    try{return parseStatus(await executeGit(workspace,profile,['status','--porcelain=v1','-z','--branch','--untracked-files=normal']));}
    catch(error){return {available:false,branch:'',entries:[],error:error.message};}
  }
  const args=['diff','--no-ext-diff','--no-textconv','--no-color'];
  if(params.staged===true)args.push('--cached');
  args.push('--');if(rel)args.push(rel);
  const text=await executeGit(workspace,profile,args);
  if(!text && rel && !params.staged){
    const untracked=await executeGit(workspace,profile,['ls-files','--others','--exclude-standard','--',rel]);
    if(untracked.trim()){
      const file=await workspaceRequest(client,'files.read',{workspaceId:workspace.id,path:rel});
      return {text:file.kind==='text'?`Новый файл: ${rel}\n\n${file.text}`:`Новый двоичный файл: ${rel}`};
    }
  }
  return {text};
}
module.exports={workspaceMethods,workspaceRequest,relative,parseStatus};
