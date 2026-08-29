# Newma Cumora Lab

This directory keeps the Cumora experiment thin enough to follow upstream.
It does not replace Newma Social, Workflow, Artifact Authority, or Hermes.

The fork keeps `main` as the clean upstream mirror. Newma-owned commits live on
`newma-lab`, which is the fork's default review branch.

## What this lab validates

- A human or workflow explicitly creates a collaboration task.
- Only that task, not ordinary chat traffic, may invoke Hermes.
- Hermes receives references to an authorized context snapshot and capability
  grant; credentials, host addresses, and raw private context stay outside the
  room event.
- Cumora-style rooms display queued, progress, completed, and failed events.
- Results carry immutable Newma artifact references instead of file paths or
  download URLs.
- An idempotency key prevents the same task from starting twice.

## Authority map

| Concern | Authority |
| --- | --- |
| Account and membership | `newma.uk` |
| Contacts, groups, and social permissions | Newma Social |
| Workflow state, approval, retry, and cancellation | Newma Workflow |
| Agent execution | Hermes through an independent connector |
| Deliverables | Newma Artifact Authority |
| Experimental room presentation and coordination patterns | This Cumora fork |

## Local checks

```bash
node --test newma-lab/test/*.test.mjs
node newma-lab/scripts/upstream-status.mjs
```

Use `--fetch` on the second command to refresh `upstream/main` before the
comparison. The check reports upstream distance and rejects Newma patches that
escape the lab boundary. It never merges or deploys upstream automatically.

## Promotion rule

An upstream change may enter a Newma release only after:

1. the fork is mergeable with `upstream/main`;
2. the bridge contract tests pass;
3. no patch escapes the allowed lab paths;
4. the change is reviewed for Newma identity, Hermes runtime, Workflow, and
   Artifact Authority compatibility.
