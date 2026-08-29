# AGENTS.md — Newma Cumora upstream lab

This repository is an isolated upstream-tracking experiment. It is not a
Newma production authority or release source.

## Product boundaries

- `https://newma.uk` remains the only Newma account and membership authority.
- Hermes Agent remains the production Agent runtime.
- Newma Social, Workflow, and Artifact Authority remain authoritative for
  relationships, orchestration state, and deliverables.
- Cumora Cloud agents, Cumora OAuth, Cumora billing, and Cumora Kubernetes pods
  must not become Newma production dependencies.

## Change boundary

- Keep Newma-owned code under `newma-lab/`.
- Lab CI may be added under `.github/workflows/newma-lab-*`.
- Do not rebrand or broadly edit Cumora core files merely to make a demo look
  like Newma.
- Do not add production endpoints, credentials, server addresses, provider
  keys, or user data.
- Do not connect this lab to production servers without a separate explicit
  user instruction.

## Upstream discipline

- Preserve the MIT license and upstream attribution.
- Treat `upstream/main` as read-only.
- Pin every reviewed baseline in `newma-lab/upstream.json`.
- Upstream updates are reviewed and tested before promotion; never auto-deploy
  a moving upstream branch.
- Prefer adapters and contracts over edits to Cumora auth, database, runtime,
  or client cores.
