'use strict';

const ACTIVITY_KINDS = new Set(['thinking', 'reading', 'editing', 'command', 'searching', 'browser', 'delegating']);

// Classify only the tool identifier. Arguments, prompts, paths and output never
// become status text or cross this boundary.
function activityForTool(toolName) {
  if (typeof toolName !== 'string' || toolName.length > 256) return 'thinking';
  const name = toolName.toLowerCase().replace(/[^a-z0-9_./-]/g, '');
  if (/(^|[_. /-])(spawn_agent|delegate|agent|task|parallel)([_. /-]|$)/.test(name)) return 'delegating';
  if (/search|grep|glob|find/.test(name)) return 'searching';
  if (/browser|playwright|navigate|screenshot|webview/.test(name)) return 'browser';
  if (/apply_patch|edit|write|replace|save_file|create_file/.test(name)) return 'editing';
  if (/read|open_file|inspect_file|fetch_file|list_file/.test(name)) return 'reading';
  if (/exec|shell|bash|terminal|command|run/.test(name)) return 'command';
  return 'thinking';
}

function createActivityTracker() {
  const active = new Map();
  function current() { return [...active.values()].at(-1) || 'thinking'; }
  return {
    current,
    clear() { active.clear(); },
    update({ phase, toolName, toolId, activity } = {}) {
      if (typeof toolId !== 'string' || !toolId || toolId.length > 256 || toolId.includes('\0')) return current();
      if (phase === 'end') active.delete(toolId);
      else if (phase === 'start') {
        if (!active.has(toolId) && active.size >= 64) return current();
        active.delete(toolId);
        active.set(toolId, ACTIVITY_KINDS.has(activity) ? activity : activityForTool(toolName));
      }
      return current();
    },
  };
}

module.exports = { ACTIVITY_KINDS, activityForTool, createActivityTracker };
