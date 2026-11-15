const { spawn } = require('node:child_process');
const electron = require('electron');
const path = require('node:path');
const args = process.argv.slice(2);
if (!args.length) { console.error('Usage: node scripts/run-electron-node.cjs script.cjs [...args]'); process.exit(2); }
const child = spawn(electron, [path.resolve(args[0]),...args.slice(1)], {stdio:'inherit',env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}});
child.on('error',error => { console.error(error.message);process.exitCode=1; });
child.on('exit',code => { process.exitCode=code ?? 1; });
