'use strict';

// The launcher may exit while the desktop and its diagnostic streams remain alive.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', error => { if (error.code !== 'EPIPE') throw error; });
}
