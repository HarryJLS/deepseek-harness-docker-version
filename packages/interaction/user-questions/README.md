---
description: "Waterfall-based question and answer service for tools, permission plugins, local answerers, and Agent-scoped Web interactions."
kind: "package-reference"
---

# @deepseek-ai/dsh-user-questions

English | [中文](README.zh.md)

## Summary

Ask the human for a decision through `ctx.userQuestions`. Live delivery waits for an answerer; durable delivery records the question, lets the requesting tool end its turn, and accepts a later decision reconstructed from session history.

## Table of Contents

- [Service: `UserQuestionService` (ctx key: `userQuestions`)](#service-userquestionservice-ctx-key-userquestions)
- [Role](#role)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="service-userquestionservice-ctx-key-userquestions"></a>
## Service: `UserQuestionService` (ctx key: `userQuestions`)

### Public API

Set `durable: true` to enable recorded tool questions; it defaults to false. `maxRequestBytes` limits a durable question or answer to 65,536 UTF-8 bytes by default. The Docker profile obtains these choices from [Nacos deployment configuration](../../../deploy/README.md#shared-confirmation).

- `ctx.userQuestions.ask(request): Promise<AskUserQuestionAnswer>` Dispatch the answerer waterfall and wait for the first accepted answer.
- `ctx.userQuestions.request(request, callId)` uses the configured delivery mode. A durable request returns without an answer; its Consumer concludes the turn. `decide()` checks the stored identity/version and records the new input under the caller's shared execution reservation.

### Key Types

- `AskUserQuestionRequest` — `{ questions: [{ id, question, detail?, header?, options?, multiSelect?, intent? }], agent?, signal? }`; `detail` supplies supporting text that providers render with the question without turning it into an option label. When present, `agent` must be the registry's exact live runtime root.
- `AskUserQuestionOption` — `{ label, description? }`.
- `AskUserQuestionIntent` — `{ kind: 'plan-review', approve }`; the tagged presentation intent below.
- `AskUserQuestionAnswer` — `{ answers: [{ id, selected, custom? }] }`.
- `UserQuestionError` — `HarnessError` subclass with codes such as `EMPTY_QUESTIONS`, `BAD_INTENT`, `NO_PROVIDER`, `ASK_ABORTED`, `CALLER_NOT_LIVE`, and `DELEGATED_CALLER`.

For a single-select question, `custom` overrides the selected choice and `selected` is empty. For a multi-select question, `custom` may supplement the labels in `selected`. A UI may preserve a skipped item as `{ id, selected: [] }`, keeping the existing answer shape while retaining other answers in the batch.

When a request carries an agent, `ask()` authenticates its exact identity through the live `AgentRegistry` and admits only a runtime root. Durable lineage is not authority: a session with historical delegation depth may ask after it is resumed as a new runtime root, while a live child owned by another agent is rejected even if its durable depth is zero. The Web answerer receives only Agent-scoped requests; an agentless programmatic request remains available to unscoped local waterfall listeners and fails with `NO_PROVIDER` when none accepts it.

### Presentation intent

`intent` declares that a question IS a known kind of decision, so a UI that recognises the tag may present it as such — `plan-review` says `detail` is a plan under review, and `dsh-plan-mode` sets it on the `exit_plan_mode` question. An intent changes presentation only: a UI honouring it answers with the same option labels a generic UI would send, and a UI that does not know the tag renders the generic option list, so callers read the same answer fields either way. `approve` names the label that approves rather than relying on option order. `ask()` rejects with `BAD_INTENT` the two assertions no type can carry: an `approve` naming none of that question's own options, and an intent on a question with no `detail` — the thing it declares itself a review of.

<a id="role"></a>
## Role

The service and runtime invariant are separate self-contained bundles. Their shared validators are stateless; both entries load from the published file inventory without a private generated chunk.

Consumers such as `@deepseek-ai/dsh-tool-ask-user` use this service; the Web client supplies live answers through Remote Events or durable decisions through Session Controller. Pending durable questions block further tool execution and model steps until answered or dismissed. The loop's existing turn-conclusion mechanism ends the requesting turn.

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-tool-ask-user`, which retains a successful answer as compact JSON or one of these failures: `Error: ask_user_question was aborted before the user answered`, `Error: ask_user_question requires at least one question`, `Error: human interaction requires the exact live calling agent when an agent is supplied`, `Error: human interaction is unavailable while the calling agent is owned by another live agent; include the unresolved question or decision in the child agent's final result`, `Error: no user-questions answerer accepted the request`, or `Error: <message>`. Waiting for the human adds no tokens.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Agent-scoped Web answering** — Remote Events route the shipped Web answerer only when the request carries a live Agent scope; agentless callers need an unscoped local waterfall listener.
- **The vocabulary is the question-form shape only** — selectable options plus optional custom text; richer interaction shapes (file pickers, diff-preview confirmations) have no seam vocabulary yet.


<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The single provider slot is validated at registration and asks return directly to their caller; the seam publishes no independent request/answer audit stream.
