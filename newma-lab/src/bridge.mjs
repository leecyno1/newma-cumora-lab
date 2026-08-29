const TASK_SOURCES = new Set(["newma-social", "newma-workflow"]);
const TASK_OUTCOMES = new Set(["completed", "failed"]);
const ENVELOPE_KEYS = new Set([
  "schema_version",
  "kind",
  "source",
  "task_id",
  "idempotency_key",
  "objective",
  "requested_by",
  "requested_at",
  "assignee_refs",
  "context_snapshot",
  "capability_grant_ref",
  "reply_target",
  "workflow_ref",
]);

export class NewmaCumoraContractError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "NewmaCumoraContractError";
    this.code = code;
  }
}

export function normalizeTaskEnvelope(input) {
  const value = object(input, "task_envelope");
  rejectUnknown(value, ENVELOPE_KEYS, "task_envelope");
  if (value.schema_version !== 1) {
    throw new NewmaCumoraContractError("unsupported_schema_version");
  }
  if (value.kind !== "collaboration_task") {
    throw new NewmaCumoraContractError(
      "explicit_task_required",
      "ordinary chat messages cannot invoke Hermes",
    );
  }
  if (!TASK_SOURCES.has(value.source)) {
    throw new NewmaCumoraContractError("invalid_task_source");
  }

  const workflowRef = optionalWorkflowReference(value.workflow_ref);
  return {
    schema_version: 1,
    kind: "collaboration_task",
    source: value.source,
    task_id: text(value.task_id, "task_id", 256),
    idempotency_key: text(value.idempotency_key, "idempotency_key", 256),
    objective: text(value.objective, "objective", 10_000),
    requested_by: text(value.requested_by, "requested_by", 256),
    requested_at: timestamp(value.requested_at, "requested_at"),
    assignee_refs: identifiers(value.assignee_refs, "assignee_refs", 16),
    context_snapshot: versionedReference(
      value.context_snapshot,
      "context_snapshot",
      "snapshot_id",
    ),
    capability_grant_ref: versionedReference(
      value.capability_grant_ref,
      "capability_grant_ref",
      "grant_id",
    ),
    reply_target: replyTarget(value.reply_target),
    ...(workflowRef ? { workflow_ref: workflowRef } : {}),
  };
}

export function toHermesInvocation(envelope) {
  const task = normalizeTaskEnvelope(envelope);
  return {
    schema_version: 1,
    contract: "newma.hermes.collaboration-task",
    task_id: task.task_id,
    idempotency_key: task.idempotency_key,
    objective: task.objective,
    actor_ref: task.requested_by,
    assignee_refs: [...task.assignee_refs],
    context_snapshot: { ...task.context_snapshot },
    capability_grant_ref: { ...task.capability_grant_ref },
    reply_target: { ...task.reply_target },
    ...(task.workflow_ref ? { workflow_ref: { ...task.workflow_ref } } : {}),
  };
}

export function createNewmaCumoraBridge({
  publishEvent,
  executeHermes,
  now = () => new Date().toISOString(),
} = {}) {
  if (typeof publishEvent !== "function") {
    throw new TypeError("publishEvent must be a function");
  }
  if (typeof executeHermes !== "function") {
    throw new TypeError("executeHermes must be a function");
  }
  if (typeof now !== "function") throw new TypeError("now must be a function");

  const executions = new Map();

  function dispatch(input, { signal, onProgress } = {}) {
    const task = normalizeTaskEnvelope(input);
    if (onProgress !== undefined && typeof onProgress !== "function") {
      throw new TypeError("onProgress must be a function");
    }
    const existing = executions.get(task.idempotency_key);
    if (existing) {
      if (existing.taskId !== task.task_id) {
        throw new NewmaCumoraContractError("idempotency_key_conflict");
      }
      return existing.promise;
    }
    const promise = run(task, { signal, onProgress });
    executions.set(task.idempotency_key, { taskId: task.task_id, promise });
    return promise;
  }

  async function run(task, { signal, onProgress }) {
    await publishEvent(roomEvent("newma.task.queued", task, now, {
      objective: task.objective,
      assignee_refs: task.assignee_refs,
      ...(task.workflow_ref ? { workflow_ref: task.workflow_ref } : {}),
    }));

    let progressSequence = 0;
    const reportProgress = async (input) => {
      const progress = normalizeProgress(input, ++progressSequence);
      if (onProgress) await onProgress(structuredClone(progress));
      await publishEvent(
        roomEvent("newma.task.progress", task, now, progress),
      );
      return progress;
    };

    try {
      if (signal?.aborted) throw abortError();
      const result = normalizeExecutionResult(
        await executeHermes(toHermesInvocation(task), {
          reportProgress,
          signal,
        }),
      );
      await publishEvent(
        roomEvent(`newma.task.${result.outcome}`, task, now, result),
      );
      return { state: result.outcome, task_id: task.task_id, result };
    } catch (_error) {
      const result = {
        outcome: "failed",
        summary: signal?.aborted ? "Agent 执行已取消" : "Agent 执行失败",
        artifact_refs: [],
      };
      await publishEvent(roomEvent("newma.task.failed", task, now, result));
      return { state: signal?.aborted ? "aborted" : "failed", task_id: task.task_id, result };
    }
  }

  return { dispatch };
}

function roomEvent(kind, task, now, payload) {
  return {
    schema_version: 1,
    kind,
    task_id: task.task_id,
    space_id: task.reply_target.space_id,
    ...(task.reply_target.thread_id
      ? { thread_id: task.reply_target.thread_id }
      : {}),
    occurred_at: timestamp(now(), "occurred_at"),
    payload: structuredClone(payload),
  };
}

function normalizeProgress(input, sequence) {
  const value = object(input, "progress");
  rejectUnknown(value, new Set(["percent", "note"]), "progress");
  if (!Number.isInteger(value.percent) || value.percent < 0 || value.percent > 100) {
    throw new NewmaCumoraContractError("invalid_progress_percent");
  }
  return {
    sequence,
    percent: value.percent,
    note: text(value.note, "progress.note", 2_000),
  };
}

function normalizeExecutionResult(input) {
  const value = object(input, "execution_result");
  rejectUnknown(
    value,
    new Set(["outcome", "summary", "artifact_refs"]),
    "execution_result",
  );
  if (!TASK_OUTCOMES.has(value.outcome)) {
    throw new NewmaCumoraContractError("invalid_execution_outcome");
  }
  return {
    outcome: value.outcome,
    summary: text(value.summary, "summary", 10_000),
    artifact_refs: artifactReferences(value.artifact_refs),
  };
}

function artifactReferences(input) {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > 16) {
    throw new NewmaCumoraContractError("invalid_artifact_refs");
  }
  const seen = new Set();
  return input.map((item) => {
    const value = object(item, "artifact_ref");
    const normalized = {
      artifact_id: text(value.artifact_id, "artifact_id", 256),
      title: text(value.title, "artifact.title", 500),
      kind: text(value.kind, "artifact.kind", 128),
      authority: text(value.authority, "artifact.authority", 256),
      revision: text(value.revision, "artifact.revision", 256),
      ...(value.media_type
        ? { media_type: text(value.media_type, "artifact.media_type", 256) }
        : {}),
    };
    const key = `${normalized.authority}\u0000${normalized.artifact_id}\u0000${normalized.revision}`;
    if (seen.has(key)) {
      throw new NewmaCumoraContractError("duplicate_artifact_ref");
    }
    seen.add(key);
    return normalized;
  });
}

function optionalWorkflowReference(input) {
  if (input === undefined || input === null) return null;
  const value = object(input, "workflow_ref");
  rejectUnknown(
    value,
    new Set(["run_id", "project_id", "mod_id", "workspace_id"]),
    "workflow_ref",
  );
  return {
    run_id: text(value.run_id, "workflow_ref.run_id", 256),
    project_id: text(value.project_id, "workflow_ref.project_id", 128),
    mod_id: text(value.mod_id, "workflow_ref.mod_id", 128),
    workspace_id: text(value.workspace_id, "workflow_ref.workspace_id", 256),
  };
}

function versionedReference(input, field, idField) {
  const value = object(input, field);
  rejectUnknown(value, new Set(["authority", idField, "revision"]), field);
  return {
    authority: text(value.authority, `${field}.authority`, 256),
    [idField]: text(value[idField], `${field}.${idField}`, 256),
    revision: text(value.revision, `${field}.revision`, 256),
  };
}

function replyTarget(input) {
  const value = object(input, "reply_target");
  rejectUnknown(value, new Set(["space_id", "thread_id"]), "reply_target");
  return {
    space_id: text(value.space_id, "reply_target.space_id", 256),
    ...(value.thread_id
      ? { thread_id: text(value.thread_id, "reply_target.thread_id", 256) }
      : {}),
  };
}

function identifiers(input, field, maximum) {
  if (!Array.isArray(input) || input.length === 0 || input.length > maximum) {
    throw new NewmaCumoraContractError(`invalid_${field}`);
  }
  const values = input.map((value) => text(value, field, 256));
  if (new Set(values).size !== values.length) {
    throw new NewmaCumoraContractError(`duplicate_${field}`);
  }
  return values;
}

function object(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new NewmaCumoraContractError(`invalid_${field}`);
  }
  return value;
}

function rejectUnknown(value, allowed, field) {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) {
    throw new NewmaCumoraContractError(
      `unknown_${field}_field`,
      `${field}.${unknown} is not part of the contract`,
    );
  }
}

function text(value, field, maximum) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) {
    throw new NewmaCumoraContractError(`invalid_${field}`);
  }
  return value.trim();
}

function timestamp(value, field) {
  const normalized = text(value, field, 64);
  if (!Number.isFinite(Date.parse(normalized))) {
    throw new NewmaCumoraContractError(`invalid_${field}`);
  }
  return new Date(normalized).toISOString();
}

function abortError() {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}
