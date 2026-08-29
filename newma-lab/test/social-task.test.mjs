import assert from "node:assert/strict";
import test from "node:test";
import { createNewmaCumoraBridge } from "../src/bridge.mjs";
import {
  createSocialTaskExecutor,
  mapClaimedSocialTask,
  NewmaSocialTaskMappingError,
} from "../src/social-task.mjs";

function claimedTask(overrides = {}) {
  return {
    id: "social-task-1",
    space_id: "space-1",
    title: "比较【Buzz】与【Cumora】的协作机制",
    created_by: "human-1",
    created_at: "2026-08-29T00:00:00.000Z",
    status: "claimed",
    assignee_id: "agent:researcher",
    claim_generation: 2,
    lease_id: "must-not-cross-the-bridge",
    instructions: [{ body: "private steering" }],
    workflow_ref: {
      run_id: "run-1",
      project_id: "social",
      mod_id: "research",
      workspace_id: "workspace-1",
    },
    ...overrides,
  };
}

const contextSnapshot = {
  authority: "newma-workflow",
  snapshot_id: "snapshot-1",
  revision: "4",
};

const capabilityGrantRef = {
  authority: "newma-authority",
  grant_id: "grant-1",
  revision: "7",
};

test("maps only an actively claimed Social task into the collaboration contract", () => {
  const envelope = mapClaimedSocialTask({
    task: claimedTask(),
    contextSnapshot,
    capabilityGrantRef,
  });

  assert.equal(envelope.idempotency_key, "social-task-1:2");
  assert.equal(envelope.objective, "比较【Buzz】与【Cumora】的协作机制");
  assert.deepEqual(envelope.assignee_refs, ["agent:researcher"]);
  assert.equal(envelope.context_snapshot.snapshot_id, "snapshot-1");
  assert.equal("lease_id" in envelope, false);
  assert.equal("instructions" in envelope, false);
});

test("does not map an open task before Social atomically claims it", () => {
  assert.throws(
    () =>
      mapClaimedSocialTask({
        task: claimedTask({ status: "open", claim_generation: 0 }),
        contextSnapshot,
        capabilityGrantRef,
      }),
    (error) =>
      error instanceof NewmaSocialTaskMappingError &&
      error.code === "claimed_task_required",
  );
});

test("runs through the Social executeTask injection and relays safe progress", async () => {
  const roomEvents = [];
  const socialProgress = [];
  const invocations = [];
  const bridge = createNewmaCumoraBridge({
    now: () => "2026-08-29T01:00:00.000Z",
    publishEvent: async (event) => roomEvents.push(event),
    executeHermes: async (invocation, { reportProgress }) => {
      invocations.push(invocation);
      await reportProgress({ percent: 60, note: "已完成资料核验" });
      return {
        outcome: "completed",
        summary: "本地协作闭环完成",
        artifact_refs: [
          {
            artifact_id: "report-1",
            title: "协作架构对比",
            kind: "report",
            authority: "newma-artifacts",
            revision: "1",
          },
        ],
      };
    },
  });
  const executeTask = createSocialTaskExecutor({
    dispatchTask: bridge.dispatch,
    resolveContextSnapshot: async (task) => {
      assert.equal("lease_id" in task, false);
      assert.equal("instructions" in task, false);
      return contextSnapshot;
    },
    resolveCapabilityGrant: async () => capabilityGrantRef,
  });

  const result = await executeTask({
    task: claimedTask(),
    reportProgress: async (progress) => socialProgress.push(progress),
  });

  assert.equal(result.outcome, "completed");
  assert.equal(result.artifact_refs[0].artifact_id, "report-1");
  assert.equal(invocations[0].idempotency_key, "social-task-1:2");
  assert.deepEqual(socialProgress, [
    { sequence: 1, percent: 60, note: "已完成资料核验" },
  ]);
  assert.deepEqual(
    roomEvents.map((event) => event.kind),
    ["newma.task.queued", "newma.task.progress", "newma.task.completed"],
  );
});
