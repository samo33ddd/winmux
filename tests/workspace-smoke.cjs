const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const {workspaceRequest}=require('../electron/workspace.cjs');
const root=path.resolve(__dirname,'..','.artifacts');
const results=[];
function wslPath(windowsPath){return '/mnt/'+windowsPath[0].toLowerCase()+windowsPath.slice(2).replace(/\\/g,'/');}
function wsl(distro,...args){return execFileSync('wsl.exe',['-d',distro,'--',...args],{encoding:'utf8',timeout:15000,windowsHide:true});}
function createWslLinks(distro,fixture,outside){
  const script=`import os,sys\nroot,outside=sys.argv[1:]\nos.symlink(os.path.join(root,'folder'),os.path.join(root,'wsl-dir-link'),target_is_directory=True)\nos.symlink(os.path.join(root,'folder','nested'),os.path.join(root,'folder','wsl-nested-link'),target_is_directory=True)\nos.symlink(os.path.join(root,'hello.txt'),os.path.join(root,'wsl-file-link.txt'))\nos.symlink(outside,os.path.join(root,'wsl-outside-link'),target_is_directory=True)\nos.symlink(os.path.join(root,'missing'),os.path.join(root,'wsl-broken-link'))`;
  wsl(distro,'python3','-c',script,wslPath(fixture),wslPath(outside));
}
async function check(cwd,profile,hasWslLinks){
  const workspace={id:'fixture',cwd,profileId:profile.id};
  const client={request:async(method)=>method==='state'?{workspaces:[workspace]}:{profiles:[profile]}};
  const rpc=(method,params={})=>workspaceRequest(client,method,{workspaceId:'fixture',...params});
  const list=await rpc('files.list');
  assert(list.entries.some(entry=>entry.name==='hello.txt'));
  assert(!list.entries.some(entry=>entry.name==='.git'));
  const listed=Object.fromEntries(list.entries.map(entry=>[entry.name,entry]));
  assert.equal(listed['dir-link'].type,'directory');
  assert.equal(listed['win-outside-link'].type,'symlink');
  await assert.rejects(()=>rpc('files.list',{path:'win-outside-link'}),/outside/i);
  if(hasWslLinks){
    assert.equal(listed['wsl-dir-link'].type,'directory');
    assert.equal(listed['wsl-file-link.txt'].type,'symlink');
    assert.equal(listed['wsl-outside-link'].type,'symlink');
    assert.equal(listed['wsl-broken-link'].type,'symlink');
  }
  for (const link of ['dir-link','wsl-dir-link']) {
    if(link.startsWith('wsl-')&&!hasWslLinks)continue;
    const linked=await rpc('files.list',{path:link});
    assert(linked.entries.some(entry=>entry.name==='hello.txt'));
    assert.equal(linked.entries.find(entry=>entry.name==='nested-link')?.type,'directory');
    if(hasWslLinks)assert.equal(linked.entries.find(entry=>entry.name==='wsl-nested-link')?.type,'directory');
    assert((await rpc('files.list',{path:`${link}/nested-link`})).entries.some(entry=>entry.name==='inside.txt'));
    if(hasWslLinks)assert((await rpc('files.list',{path:`${link}/wsl-nested-link`})).entries.some(entry=>entry.name==='inside.txt'));
    assert.equal((await rpc('files.read',{path:`${link}/hello.txt`})).kind,'text');
  }
  if(hasWslLinks){
    assert((await rpc('files.read',{path:'wsl-file-link.txt'})).text.includes('Привет'));
    await assert.rejects(()=>rpc('files.list',{path:'wsl-outside-link'}),/outside/i);
    await assert.rejects(()=>rpc('files.list',{path:'wsl-broken-link'}),/ENOENT|No such file/i);
  }
  const text=await rpc('files.read',{path:'hello.txt'});
  assert.equal(text.kind,'text');assert(text.text.includes('Привет'));
  const image=await rpc('files.read',{path:'pixel.png'});
  assert.equal(image.kind,'image');assert(image.dataUrl.startsWith('data:image/png;base64,'));
  await assert.rejects(()=>rpc('files.read',{path:'../outside'}),/Path must remain inside the current directory/);
  const status=await rpc('git.status');
  assert.equal(status.available,true,status.error);assert(status.branch.includes('main'));
  assert(status.entries.some(entry=>entry.path==='hello.txt'&&entry.worktree==='M'));
  assert(status.entries.some(entry=>entry.path==='staged.txt'&&entry.index==='A'));
  for (const file of ['new-folder/nested dir/файл name.txt','new-folder/space name.txt','new-folder/binary.dat','new-folder/large.txt']) {
    assert(status.entries.some(entry=>entry.path===file&&entry.worktree==='?'),`${profile.id}: missing ${file}: ${JSON.stringify(status.entries)}`);
  }
  assert(!status.entries.some(entry=>entry.path==='new-folder/'));
  const diff=await rpc('git.diff',{path:'hello.txt'});
  assert(diff.text.includes('+Привет'));
  assert((await rpc('git.diff',{path:'new-folder/nested dir/файл name.txt'})).text.includes('Nested Unicode'));
  assert((await rpc('git.diff',{path:'new-folder/space name.txt'})).text.includes('Space file'));
  assert((await rpc('git.diff',{path:'new-folder/binary.dat'})).text.includes('New binary file'));
  await assert.rejects(()=>rpc('git.diff',{path:'new-folder/large.txt'}),/Preview limit/);
  assert((await rpc('git.diff',{path:'staged.txt',staged:true})).text.includes('+staged'));
  const saved=await rpc('files.write',{path:'hello.txt',expectedText:text.text,text:'Привет — saved\n'});
  assert.equal(saved.text,'Привет — saved\n');
  await assert.rejects(()=>rpc('files.write',{path:'hello.txt',expectedText:text.text,text:'stale'}),/changed on disk/);
  assert.equal((await rpc('files.read',{path:'hello.txt'})).text,saved.text);
  await assert.rejects(()=>rpc('files.write',{path:'../outside',expectedText:'',text:'x'}),/inside the current directory/);
  await assert.rejects(()=>rpc('files.write',{path:'hello.txt',expectedText:saved.text,text:'x'.repeat(512*1024+1)}),/512 KB/);
  for (const file of ['invalid.txt','binary.dat','large.txt','image.svg']) {
    const before=await rpc('files.read',{path:file});
    await assert.rejects(()=>rpc('files.write',{path:file,expectedText:before.text||'',text:'must not replace'}),/Only complete UTF-8/);
  }
  await rpc('files.write',{path:'hello.txt',expectedText:saved.text,text:text.text});
  results.push(`${profile.id}: ${hasWslLinks?'real WSL directory/file/outside/broken symlinks':'Windows directory junction and outside link'}, nested expansion, tracked/staged/all untracked Git, Unicode/spaces, and file operations passed`);
}
(async()=>{
  await fs.mkdir(root,{recursive:true});
  const fixture=await fs.mkdtemp(path.join(root,'workspace-smoke-'));
  const outside=fixture+'-outside';
  try{
    let distro;
    try {distro=execFileSync('wsl.exe',['--list','--quiet'],{timeout:10000,windowsHide:true}).toString('utf16le').replace(/\u0000/g,'').split(/\r?\n/).map(s=>s.trim()).find(s=>s==='Ubuntu-24.04') || execFileSync('wsl.exe',['--list','--quiet'],{timeout:10000,windowsHide:true}).toString('utf16le').replace(/\u0000/g,'').split(/\r?\n/).map(s=>s.trim()).find(s=>s&&!s.includes('docker'));}
    catch(error){results.push(`WSL unavailable: ${error.code || error.status}`);}
    await fs.mkdir(path.join(fixture,'folder','nested'),{recursive:true});
    await fs.mkdir(path.join(fixture,'new-folder','nested dir'),{recursive:true});
    await fs.mkdir(outside);
    await fs.writeFile(path.join(fixture,'hello.txt'),'Initial content\n');
    await fs.writeFile(path.join(fixture,'pixel.png'),Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64'));
    await fs.writeFile(path.join(fixture,'folder','hello.txt'),'Linked folder\n');
    await fs.writeFile(path.join(fixture,'folder','nested','inside.txt'),'Nested link\n');
    await fs.writeFile(path.join(outside,'outside.txt'),'outside');
    await fs.writeFile(path.join(fixture,'.gitignore'),['/dir-link','/win-outside-link','/wsl-dir-link','/wsl-file-link.txt','/wsl-outside-link','/wsl-broken-link','/folder/nested-link','/folder/wsl-nested-link',''].join('\n'));
    await fs.symlink(path.join(fixture,'folder'),path.join(fixture,'dir-link'),'junction');
    await fs.symlink(path.join(fixture,'folder','nested'),path.join(fixture,'folder','nested-link'),'junction');
    await fs.symlink(outside,path.join(fixture,'win-outside-link'),'junction');
    const git=(...args)=>execFileSync('git',['-C',fixture,...args],{encoding:'utf8',windowsHide:true});
    git('init','-b','main');git('add','.');git('-c','user.name=Winmux Test','-c','user.email=test@example.invalid','commit','-m','fixture');
    await fs.writeFile(path.join(fixture,'hello.txt'),'Initial content\nПривет — working tree\n');
    await fs.writeFile(path.join(fixture,'new-folder','nested dir','файл name.txt'),'Nested Unicode content\n');
    await fs.writeFile(path.join(fixture,'new-folder','space name.txt'),'Space file content\n');
    await fs.writeFile(path.join(fixture,'new-folder','binary.dat'),Buffer.from([0,1,2]));
    await fs.writeFile(path.join(fixture,'new-folder','large.txt'),'x'.repeat(12*1024*1024+1));
    await fs.writeFile(path.join(fixture,'staged.txt'),'staged content\n');git('add','staged.txt');
    await fs.writeFile(path.join(fixture,'invalid.txt'),Buffer.from([0xff,0xfe,0x61]));
    await fs.writeFile(path.join(fixture,'binary.dat'),Buffer.from([0,1,2]));
    await fs.writeFile(path.join(fixture,'large.txt'),'x'.repeat(512*1024+1));
    await fs.writeFile(path.join(fixture,'image.svg'),'<svg xmlns="http://www.w3.org/2000/svg"/>');
    if(distro)createWslLinks(distro,fixture,outside);
    await check(fixture,{id:'powershell',environment:'windows'},false);
    if(distro){
      await check(wslPath(fixture),{id:`wsl:${distro}`,environment:'wsl',distro},true);
    }
    console.log(JSON.stringify({status:'passed',results},null,2));
  }finally{await fs.rm(fixture,{recursive:true,force:true});await fs.rm(outside,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
