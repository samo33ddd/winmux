const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const {workspaceRequest}=require('../electron/workspace.cjs');
const root=path.resolve(__dirname,'..','.artifacts');
const results=[];
async function check(cwd,profile){
  const workspace={id:'fixture',cwd,profileId:profile.id};
  const client={request:async(method)=>method==='state'?{workspaces:[workspace]}:{profiles:[profile]}};
  const rpc=(method,params={})=>workspaceRequest(client,method,{workspaceId:'fixture',...params});
  const list=await rpc('files.list');
  assert(list.entries.some(entry=>entry.name==='hello.txt'));
  assert(!list.entries.some(entry=>entry.name==='.git'));
  const text=await rpc('files.read',{path:'hello.txt'});
  assert.equal(text.kind,'text');assert(text.text.includes('Привет'));
  const image=await rpc('files.read',{path:'pixel.png'});
  assert.equal(image.kind,'image');assert(image.dataUrl.startsWith('data:image/png;base64,'));
  await assert.rejects(()=>rpc('files.read',{path:'../outside'}),/внутри проекта/);
  const status=await rpc('git.status');
  assert.equal(status.available,true,status.error);assert(status.branch.includes('main'));
  assert(status.entries.some(entry=>entry.path==='hello.txt'&&entry.worktree==='M'));
  const diff=await rpc('git.diff',{path:'hello.txt'});
  assert(diff.text.includes('+Привет'));
  results.push(`${profile.id}: file listing, Unicode text, image bytes, traversal rejection, actual Git branch/status/diff passed`);
}
(async()=>{
  await fs.mkdir(root,{recursive:true});
  const fixture=await fs.mkdtemp(path.join(root,'workspace-smoke-'));
  try{
    await fs.writeFile(path.join(fixture,'hello.txt'),'Initial content\n');
    await fs.writeFile(path.join(fixture,'pixel.png'),Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64'));
    const git=(...args)=>execFileSync('git',['-C',fixture,...args],{encoding:'utf8',windowsHide:true});
    git('init','-b','main');git('add','.');git('-c','user.name=Winmux Test','-c','user.email=test@example.invalid','commit','-m','fixture');
    await fs.writeFile(path.join(fixture,'hello.txt'),'Initial content\nПривет — working tree\n');
    await check(fixture,{id:'powershell',environment:'windows'});
    let distro;
    try {distro=execFileSync('wsl.exe',['--list','--quiet'],{timeout:10000,windowsHide:true}).toString('utf16le').replace(/\u0000/g,'').split(/\r?\n/).map(s=>s.trim()).find(s=>s&&!s.includes('docker'));}
    catch(error){results.push(`WSL unavailable: ${error.code || error.status}`);}
    if(distro){
      const wslPath='/mnt/'+fixture[0].toLowerCase()+fixture.slice(2).replace(/\\/g,'/');
      await check(wslPath,{id:`wsl:${distro}`,environment:'wsl',distro});
    }
    console.log(JSON.stringify({status:'passed',results},null,2));
  }finally{await fs.rm(fixture,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
