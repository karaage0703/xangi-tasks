export const TASK_STATUSES = new Set(['inbox', 'open', 'closed']);
export const EXECUTION_STATUSES = new Set(['idle', 'working', 'delegating', 'running', 'review', 'completing', 'failed']);

// A presentation/transition key. Persisted task status always stays inbox/open/closed.
export function taskPhase(task) {
  if (task.status === 'open') return task.executionStatus;
  return task.status === 'closed' && task.closedReason === 'dismissed' ? 'dismissed' : task.status;
}

export function phaseFields(phase) {
  if (EXECUTION_STATUSES.has(phase)) return { status: 'open', executionStatus: phase, closedReason: null };
  if (phase === 'inbox') return { status: 'inbox', executionStatus: 'idle', closedReason: null };
  if (phase === 'closed' || phase === 'dismissed') return { status: 'closed', executionStatus: 'idle', closedReason: phase === 'closed' ? 'completed' : 'dismissed' };
  throw new Error('Invalid task state');
}

export function validateTaskState(task) {
  if (!TASK_STATUSES.has(task.status) || !EXECUTION_STATUSES.has(task.executionStatus)) throw new Error('Invalid task state; convert old task data before starting');
  if (task.status !== 'open' && task.executionStatus !== 'idle') throw new Error('Only open tasks can execute');
  if (task.status === 'closed' ? !['completed', 'dismissed'].includes(task.closedReason) : task.closedReason !== null) throw new Error('Invalid close reason');
  return task;
}
