'use strict';

// Verified against vercel-labs/skills docs/commands.md and docs/agents.md.
// Keep the UI's offered subset in sync. Deliberately no arbitrary flags or global scope.
const agents = new Set(['codex', 'claude-code', 'opencode', 'cursor', 'gemini-cli', 'github-copilot', 'pi', 'hermes-agent']);
const sourcePattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const namePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function validToken(value, pattern) {
  // JS $ also matches before a final newline. Reject all whitespace explicitly.
  return typeof value === 'string' && !/\s/.test(value) && pattern.test(value);
}

async function installSkills(client, params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)
    || Object.keys(params).some(key => !['workspaceId', 'source', 'agent', 'skill'].includes(key))) {
    fail('INVALID_ARGUMENT', 'Expected workspaceId, source, agent and optional skill only.');
  }
  const { workspaceId, source, agent, skill } = params;
  if (!validToken(workspaceId, /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/)) fail('INVALID_ARGUMENT', 'Invalid workspaceId.');
  if (!validToken(source, sourcePattern)) fail('INVALID_ARGUMENT', 'Source must be a GitHub owner/repo.');
  if (!agents.has(agent)) fail('INVALID_ARGUMENT', 'Unsupported skills agent.');
  if (skill !== undefined && !validToken(skill, namePattern)) fail('INVALID_ARGUMENT', 'Skill must start with a letter or digit and contain only letters, digits, dots, underscores or hyphens (max 128).');
  const command = `npx skills add ${source} --agent ${agent}${skill ? ` --skill ${skill}` : ''} --yes`;
  const state = await client.request('state');
  const environment = await client.request('environment');
  const workspace = state.workspaces.find(item => item.id === workspaceId);
  if (!workspace) fail('NOT_FOUND', 'Workspace not found.');
  if (!workspace.panes?.length) fail('NO_PANES', 'The workspace needs a terminal before installing skills.');
  if (typeof workspace.cwd !== 'string' || !workspace.cwd || /[\x00-\x1f]/.test(workspace.cwd)) fail('INVALID_CWD', 'The workspace needs a valid startup directory.');
  const profile = environment.profiles.find(item => item.id === workspace.profileId);
  if (!profile || profile.available === false || !['windows', 'wsl'].includes(profile.environment)) fail('PROFILE_UNAVAILABLE', 'Workspace shell environment is unavailable.');
  const profileId = profile.environment === 'wsl' ? workspace.profileId : 'powershell';
  if (!environment.profiles.some(item => item.id === profileId && item.available !== false)) fail('PROFILE_UNAVAILABLE', 'PowerShell is unavailable.');
  const pane = await client.request('pane.split', {
    paneId: workspace.panes[0].id, direction: 'horizontal', profileId, cwd: workspace.cwd,
  });
  if (!pane?.id || pane.status !== 'running' || workspace.panes.some(existing => existing.id === pane.id)) fail('PANE_UNAVAILABLE', 'Could not create a new running shell pane.');
  // pane.split acknowledges process creation, not shell readiness. No user profiles
  // are loaded by these profiles; wait for the baseline shell prompt before typing.
  const deadline = Date.now() + 15000;
  let ready = false;
  do {
    if (typeof pane.shellReady === 'boolean') {
      const current = await client.request('state');
      ready = current.workspaces.flatMap(item => item.panes).some(item => item.id === pane.id && item.shellReady && item.status === 'running');
    } else {
      const screen = await client.request('pane.screen', { paneId: pane.id });
      const lastLine = (screen.text || '').trimEnd().split(/\r?\n/).at(-1) || '';
      ready = profile.environment === 'wsl' ? /[$#]$/.test(lastLine) : /^PS .*>$/.test(lastLine);
    }
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 150));
  } while (Date.now() < deadline);
  // Leave the new pane visible for diagnosis, but never fall back to another pane.
  if (!ready) fail('SHELL_NOT_READY', 'The new shell did not become ready. No command was sent; inspect its terminal and retry.');
  await client.request('pane.input', { paneId: pane.id, data: command + '\r' });
  return { workspaceId, paneId: pane.id, command };
}

module.exports = { installSkills };
