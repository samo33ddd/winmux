const { spawn } = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname,'..');
let desktop;
let ended=false;
const vite=spawn(process.execPath,[path.join(root,'node_modules/vite/bin/vite.js')],{cwd:root,stdio:'inherit'});
function stop(){ if(ended)return; ended=true; desktop?.kill(); vite.kill(); }
process.on('SIGINT',stop);process.on('SIGTERM',stop);
vite.on('error',error=>{console.error(error);stop();process.exitCode=1;});
vite.on('exit',code=>{if(!ended){stop();process.exitCode=code??1;}});
(async()=>{
  let ready=false;
  for(let i=0;i<100;i++){
    if(ended)return;
    try{const r=await fetch('http://127.0.0.1:5173');if(r.ok){ready=true;break;}}catch{}
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  if(!ready)throw new Error('Vite did not start on 127.0.0.1:5173');
  const env={...process.env,WINMUX_DEV_URL:'http://127.0.0.1:5173'};delete env.ELECTRON_RUN_AS_NODE;
  desktop=spawn(require('electron'),['.'],{cwd:root,stdio:'inherit',env});
  desktop.on('error',error=>{console.error(error);stop();process.exitCode=1;});
  desktop.on('exit',code=>{stop();process.exitCode=code??0;});
})().catch(error=>{console.error(error);stop();process.exitCode=1;});
