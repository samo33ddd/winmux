'use strict';

const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function validTaskId(taskId) {
  return typeof taskId === 'string' && TASK_ID.test(taskId);
}

function requireTaskId(taskId) {
  if (!validTaskId(taskId)) throw new Error('Winmux task ID is invalid');
  return taskId;
}

function taskInstruction(taskId) {
  return `This terminal belongs to Winmux task ${requireTaskId(taskId)}. Follow the repository instructions. When the user's task is complete, use the installed winmux-terminal skill and task.delivery RPCs to create a PR into the primary branch, run an independent review, and resolve findings. Record the reviewer's attestation for the current HEAD with task.delivery.review; never record an approval you did not receive. Then wait for required CI on the current PR head and merge through task.delivery.merge. Never push directly to the primary branch or bypass protection. If the skill, review, CI, or permissions are unavailable, explain the blocker. Do not treat agent completion as task delivery.`;
}

function taskInstructionArgs(agent, taskId) {
  if (taskId === undefined) return [];
  requireTaskId(taskId);
  return ['claude', 'omp'].includes(agent?.id?.split(':').pop())
    ? ['--append-system-prompt', taskInstruction(taskId)]
    : [];
}

function deliverySupportFor(agentId) {
  const name = agentId === undefined ? undefined : agentId.split(':').pop();
  if (name === 'codex') return 'hooks';
  if (['claude', 'omp'].includes(name)) return 'instructions';
  return 'unsupported';
}

function codexUserPromptSubmitOutput(taskId) {
  if (taskId === undefined) return null;
  return {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: taskInstruction(taskId),
    },
  };
}

module.exports = {
  validTaskId,
  taskInstruction,
  taskInstructionArgs,
  deliverySupportFor,
  codexUserPromptSubmitOutput,
};
