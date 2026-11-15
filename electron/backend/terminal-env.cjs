'use strict';

const CLEARED_COLOR_DECISIONS = new Set(['CLICOLOR', 'FORCE_COLOR', 'NO_COLOR']);
const INTERACTIVE_TERMINAL = Object.freeze({
  TERM: 'xterm-256color',
  COLORTERM: 'truecolor',
  TERM_PROGRAM: 'Winmux',
});

function terminalEnvironment(inherited = process.env) {
  if (!inherited || typeof inherited !== 'object' || Array.isArray(inherited)) {
    throw new TypeError('Terminal environment must be an object.');
  }
  const environment = { ...inherited };
  for (const key of Object.keys(environment)) {
    if (CLEARED_COLOR_DECISIONS.has(key.toUpperCase())) delete environment[key];
  }
  return Object.assign(environment, INTERACTIVE_TERMINAL);
}

module.exports = { terminalEnvironment };
