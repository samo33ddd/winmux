'use strict';

const {
  SKILL_DESTINATIONS,
  readBundledSkills,
  installLocalSkills,
} = require('./skills-local-installer.cjs');

function fail(code, message) { throw Object.assign(new Error(message), { code }); }

function validToken(value, pattern) {
  return typeof value === 'string' && !/\s/.test(value) && pattern.test(value);
}

function profileIdFor(workspace, profile) {
  return profile.environment === 'wsl' ? workspace.profileId : 'powershell';
}

async function installSkills(client, params, runtimeOptions = {}) {
  if (!params || typeof params !== 'object' || Array.isArray(params)
    || Object.keys(params).some(key => !['workspaceId', 'agent'].includes(key))
    || Object.keys(params).length !== 2) {
    fail('INVALID_ARGUMENT', 'Expected workspaceId and agent only.');
  }
  const { workspaceId, agent } = params;
  if (!validToken(workspaceId, /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/)) fail('INVALID_ARGUMENT', 'Invalid workspaceId.');
  if (!Object.hasOwn(SKILL_DESTINATIONS, agent)) fail('INVALID_ARGUMENT', 'Unsupported skills agent.');
  const bundledSkills = readBundledSkills();
  const state = await client.request('state');
  const environment = await client.request('environment');
  const workspace = state.workspaces.find(item => item.id === workspaceId);
  if (!workspace) fail('NOT_FOUND', 'Workspace not found.');
  if (typeof workspace.cwd !== 'string' || !workspace.cwd || /[\x00-\x1f]/.test(workspace.cwd)) fail('INVALID_CWD', 'The workspace needs a valid startup directory.');
  const profile = environment.profiles.find(item => item.id === workspace.profileId);
  if (!profile || profile.available === false || !['windows', 'wsl'].includes(profile.environment)) fail('PROFILE_UNAVAILABLE', 'Workspace shell environment is unavailable.');
  const profileId = profileIdFor(workspace, profile);
  if (!environment.profiles.some(item => item.id === profileId && item.available !== false)) fail('PROFILE_UNAVAILABLE', 'The selected shell environment is unavailable.');
  const result = await installLocalSkills({ workspace, profile, agent, skills: bundledSkills, runtimeOptions });
  return {
    workspaceId,
    ...result,
    installedSkills: result.skills.filter(item => item.status === 'install').map(item => item.name),
    unchangedSkills: result.skills.filter(item => item.status === 'unchanged').map(item => item.name),
  };
}

module.exports = { installSkills };
