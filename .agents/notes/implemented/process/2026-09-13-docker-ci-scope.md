# Agent Note: CI scope for the Docker repository

Status: implemented

English | [中文](2026-09-13-docker-ci-scope.zh.md)

## Problem

The Docker repository deploys to Linux but inherits workflows that spend external API credits, expect upstream-owned runner pools, and run the complete unit suite on macOS. Missing credentials produce repeated preflight failures, while unavailable private runners leave reference jobs queued. Neither result establishes a Docker runtime regression.

## Decision

[Real-API E2E](../../../../.github/workflows/e2e.yml) and [CI master](../../../../.github/workflows/ci-master.yml) accept only manual dispatch. API credentials remain step-scoped, and an absent key fails before checkout or installation. Reference suites require an explicit selection; the default Wine cache task uses a standard hosted runner, while self-hosted and larger-runner suites require their advertised pools.

[Sandbox](../../../../.github/workflows/sandbox.yml) keeps the bwrap and Landlock x64/arm64 checks automatic on master pushes. The bwrap job also runs the complete unit suite and deployment configuration tests. Seatbelt and macOS unit parity run only on manual dispatch. Enabled jobs retain their test assertions; changing the trigger does not turn a failing test into success.

Sandbox and packed-distribution commands require both a successful test-process exit and the complete expected file count. A passing file summary cannot override a process failure, and a successful process cannot hide self-skipped platform tests.

This decision partially supersedes the trigger policies in the [real-API CI note](../testing/2026-06-19-real-api-e2e-ci.md) and [serial reference note](2026-07-21-serial-cross-platform-ci-reference.md). Their credential-security and independent-reference rationale remains useful, so both stay active. Pull-request CI and release workflows retain their separate policies.

## Alternatives considered

**Delete every inherited workflow and test.** This removes Linux confinement, deployment, and regression evidence that remains relevant to the Docker service.

**Keep automatic jobs and provision upstream infrastructure.** The downstream deployment does not require those private pools or continuous paid API coverage. Manual dispatch preserves the checks for deliberate use.

**Ignore failures with `continue-on-error`.** A started check must still report a genuine regression. Optional execution belongs in trigger selection, not in failure handling.

## Consequences

Ordinary pushes require no API key or self-hosted reference pool. Live API and macOS regressions are detected only when those suites are selected manually. Branch protection must not require manual-only checks. Existing queued or failed GitHub runs retain their original workflow definition and are not repaired by editing a later commit.

## Verification

[Workflow tests](../../../../scripts/ci-workflow.spec.ts) pin the automatic Linux inventory, manual selections, and credential scope, execute the API preflight with missing and synthetic keys, and run every Sandbox shell wrapper against successful, failed, and self-skipped test results. [Remote-event tests](../../../../packages/api/remotes/tests/remote-events.host.spec.ts) use Session-backed subjects and verify routing by the durable owner rather than the ambient request user. [Fixture-layout tests](../../../../scripts/session-fixture-layout.spec.ts) require canonical session records without changing their decoded payloads.
