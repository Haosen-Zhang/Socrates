# Task Plan: CAT-001 model context-window catalog

## Goal

Resolve trustworthy model context-window defaults, preserve user overrides and
provenance, and remove guessed limits without starting dependent compaction
work.

## Phases

- [x] Confirm ADR-008 merge and create #121 worktree.
- [x] Add catalog resolution, verified app-data cache, and exact provider matching.
- [x] Add Agent/API snapshots, migration, and form prefill/override behavior.
- [x] Remove the unknown-model 32K fallback and add targeted regression tests.
- [x] Run full repository gates.
- [ ] Publish the independent PR.

## Dependency boundary

CMP-001 remains blocked by HIST-001, HIST-002, and MEM-002. This Ticket does
not add a parallel history store or an untraceable summary mechanism.
