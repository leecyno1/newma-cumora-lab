import assert from "node:assert/strict";
import test from "node:test";
import {
  NewmaCumoraContractError,
  createNewmaCumoraBridge,
  normalizeTaskEnvelope,
  toHermesInvocation,
} from "../src/bridge.mjs";

function envelope(overrides = {}) {
  return {
    schema_version: 1,
    kind: "collaboration_task",
    source: "newma-social",
    task_id: "task-1",
    idempotency_key: "task-1-v1",
    objective: "比较【Buzz】与【Cumora】的协作机制",
    requested_by: "human-1",
    requested_at: "2026-08-29T00:00:00.000Z",
    assignee_refs: ["agent:researcher", "agent:reviewer"],
    context_snapshot: {
      authority: "newma-workflow",
      snapshot_id: "snapshot-1",
      revision: "1",
    },
    capability_grant_ref: {
      authority: "newma-authority",
      grant_id: "grant-1",
      revision: "1",
    },
    reply_target: { space_id: "space-1", thread_id: "topic-1" },
    workflow_ref: {
      run_id: "run-1",
      project_id: "social",
      mod_id: "research",
      workspace_id: "workspace-1",
    },
    ...overrides,
  };
}

test("ordinary chat cannot invoke Hermes", () => {
  assert.throws(
    () => normalizeTaskEnvelope(envelope({ kind: "message" })),
    (error) =>
      error instanceof NewmaCumoraContractError &&
      error.code === "explicit_task_required",
  );
});

test("task envelope rejects credentials and endpoints outside the contract", () => {
  assert.throws(
    () => normalizeTaskEnvelope(envelope({ access_token: "secret" })),
    (error) =>
      error instanceof NewmaCumoraContractError &&
      error.code === "unknown_task_envelope_field",
  );
});

test("Hermes invocation contains references, not room credentials or raw context", () => {
  const invocation = toHermesInvocation(envelope());
  assert.equal(invocation.contract, "newma.hermes.collaboration-task");
  assert.equal(invocation.context_snapshot.snapshot_id, "snapshot-1");
  assert.equal(invocation.capability_grant_ref.grant_id, "grant-1");
  assert.equal("access_token" in invocation, false);
  assert.equal("endpoint" in invocation, false);
  assert.equal("messages" in invocation, false);
});

test("bridge publishes task progress and immutable artifact references", async () => {
  const events = [];
  let executions = 0;
  const bridge = createNewmaCumoraBridge({
    now: () => "2026-08-29T01:00:00.000Z",
    publishEvent: async (event) => events.push(event),
    executeHermes: async (_request, { reportProgress }) => {
      executions += 1;
      await reportProgress({ percent: 40, note: "已完成资料整理" });
      return {
        outcome: "completed",
        summary: "协作分析完成",
        artifact_refs: [
          {
            artifact_id: "artifact-1",
            title: "Buzz 与 Cumora 对比",
            kind: "report",
            authority: "newma-artifacts",
            revision: "1",
            media_type: "text/markdown",
            url: "https://must-not-enter-room.example/file",
            path: "/private/file",
          },
        ],
      };
    },
  });

  const first = bridge.dispatch(envelope());
  const duplicate = bridge.dispatch(envelope());
  const [result, sameResult] = await Promise.all([first, duplicate]);

  assert.equal(executions, 1);
  assert.deepEqual(sameResult, result);
  assert.equal(result.state, "completed");
  assert.deepEqual(
    events.map((event) => event.kind),
    ["newma.task.queued", "newma.task.progress", "newma.task.completed"],
  );
  assert.equal(events[1].payload.sequence, 1);
  assert.equal(events[2].payload.artifact_refs[0].artifact_id, "artifact-1");
  assert.equal("url" in events[2].payload.artifact_refs[0], false);
  assert.equal("path" in events[2].payload.artifact_refs[0], false);
  assert.equal(JSON.stringify(events).includes("grant-1"), false);
});

test("executor failures return a stable product-safe room event", async () => {
  const events = [];
  const bridge = createNewmaCumoraBridge({
    publishEvent: async (event) => events.push(event),
    executeHermes: async () => {
      throw new Error("provider token leaked in internal stack");
    },
  });

  const result = await bridge.dispatch(envelope({ idempotency_key: "failure-1" }));
  assert.equal(result.state, "failed");
  assert.equal(result.result.summary, "Agent 执行失败");
  assert.equal(events.at(-1).kind, "newma.task.failed");
  assert.equal(JSON.stringify(events).includes("provider token"), false);
});

