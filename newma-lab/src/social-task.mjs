import { normalizeTaskEnvelope } from "./bridge.mjs";

const ACTIVE_STATUSES = new Set(["claimed", "running"]);

export class NewmaSocialTaskMappingError extends Error {
  constructor(code) {
    super(code);
    this.name = "NewmaSocialTaskMappingError";
    this.code = code;
  }
}

export function mapClaimedSocialTask({
  task,
  contextSnapshot,
  capabilityGrantRef,
  replyTarget,
} = {}) {
  const value = claimedTask(task);

  return normalizeTaskEnvelope({
    schema_version: 1,
    kind: "collaboration_task",
    source: "newma-social",
    task_id: value.id,
    idempotency_key: `${value.id}:${value.claim_generation}`,
    objective: value.title,
    requested_by: value.created_by,
    requested_at: value.created_at,
    assignee_refs: [value.assignee_id],
    context_snapshot: contextSnapshot,
    capability_grant_ref: capabilityGrantRef,
    reply_target: replyTarget || { space_id: value.space_id },
    ...(value.workflow_ref ? { workflow_ref: value.workflow_ref } : {}),
  });
}

export function createSocialTaskExecutor({
  dispatchTask,
  resolveContextSnapshot,
  resolveCapabilityGrant,
  resolveReplyTarget = (task) => ({ space_id: task.space_id }),
} = {}) {
  for (const [name, value] of [
    ["dispatchTask", dispatchTask],
    ["resolveContextSnapshot", resolveContextSnapshot],
    ["resolveCapabilityGrant", resolveCapabilityGrant],
    ["resolveReplyTarget", resolveReplyTarget],
  ]) {
    if (typeof value !== "function") throw new TypeError(`${name} must be a function`);
  }

  return async function executeTask({ task, reportProgress, signal } = {}) {
    if (typeof reportProgress !== "function") {
      throw new TypeError("reportProgress must be a function");
    }
    const activeTask = claimedTask(task);
    const resolutionTask = taskDescriptor(activeTask);
    const [contextSnapshot, capabilityGrantRef, replyTarget] = await Promise.all([
      resolveContextSnapshot(resolutionTask),
      resolveCapabilityGrant(resolutionTask),
      resolveReplyTarget(resolutionTask),
    ]);
    const envelope = mapClaimedSocialTask({
      task: activeTask,
      contextSnapshot,
      capabilityGrantRef,
      replyTarget,
    });
    const execution = record(
      await dispatchTask(envelope, { signal, onProgress: reportProgress }),
      "execution",
    );
    const result = record(execution.result, "execution.result");
    return {
      outcome: result.outcome,
      summary: result.summary,
      ...(Array.isArray(result.artifact_refs) && result.artifact_refs.length
        ? { artifact_refs: result.artifact_refs }
        : {}),
    };
  };
}

function claimedTask(input) {
  const value = record(input, "task");
  if (!ACTIVE_STATUSES.has(value.status)) {
    throw new NewmaSocialTaskMappingError("claimed_task_required");
  }
  if (!Number.isSafeInteger(value.claim_generation) || value.claim_generation < 1) {
    throw new NewmaSocialTaskMappingError("invalid_claim_generation");
  }
  return value;
}

function taskDescriptor(task) {
  return {
    id: task.id,
    space_id: task.space_id,
    title: task.title,
    created_by: task.created_by,
    created_at: task.created_at,
    status: task.status,
    assignee_id: task.assignee_id,
    claim_generation: task.claim_generation,
    ...(task.workflow_ref
      ? { workflow_ref: structuredClone(task.workflow_ref) }
      : {}),
  };
}

function record(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new NewmaSocialTaskMappingError(`invalid_${field}`);
  }
  return value;
}
