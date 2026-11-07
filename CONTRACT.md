---
id: unminted
category: component
title: operation-call - named operations with an honest ending over one-way delivery
status: draft
hydrate-when: Parts of your system call each other by name, and a caller must know how each call ended, including when that cannot be known
sovereignty: internal
supersedes: []
related: [C0, C1, A3]
---

# operation-call

The contract of record for operation-call: what a consumer can depend on, written before any consumer's architecture so that it states the whole offer.\
It also carries the fields of a mission-kit registry entry, and that entry is generated from this file when the component is filed, never written as a second copy.\
The registry id is unminted on purpose; one is minted only when the entry is admitted to the registry.

---

## Duty

Give every invocation of a named operation exactly one honest ending, within a bound its caller chose.

---

## Contract

What a consumer can depend on, one capability per row.\
A capability is named for what it offers, not for who offers it, so two components that provide the same capability share its name, and the overlap is visible.\
**Provides** means this component implements the capability; **carries from X** means it passes X's capability through its own interface.\
**Implied by Y** marks a guarantee that holds whenever Y is used, so it is never chosen on its own.\
**Requires** names the capabilities of other components a row depends on, as `component:capability`, so a census can follow an application's demand down through the components it reaches.\
The trait column names any trait a system takes on by using the capability.

| Capability | Relation | Requires | What a consumer can depend on | Trait |
|---|---|---|---|---|
| `honest-call-ending` | provides | `agp:expose-named-endpoint`, `agp:route-or-refuse-send`, `agp:delivery-disposition-report`, `agp:delivery-context`, `shape-check:plain-json-value` | Calling a named operation yields exactly one ending: answered, refused with a reason, not delivered, or unknown; exports `readCallEnding`, which reads a candidate ending as plain data (zorg's `D54`, `D55`), accepting the caller interface's direct, hop and whole-find endings. | none |
| `caller-chosen-bound` | provides | `shape-check:plain-json-value` | The caller sets the bound: total time for a whole answer, time to the next sign of life for an answer in parts; exports `readCallRequest`, and the caller reads its clock first and then each option of `CallRequest` at most once. | none |
| `answer-in-parts` | provides | `agp:route-or-refuse-send`, `agp:direct-peer-send`, `agp:delivery-context` | An answer may arrive as ordered parts; a missing part, or a stop before the end, ends the invocation as unknown, and parts already received stand. | none |
| `cancel-invocation` | provides | `agp:route-or-refuse-send` | A caller may end an invocation early, and the operation is told. | none |
| `invocation-identity` | provides | none | Every invocation carries an identity that stays the same when the invocation is repeated, so the owner of an effect can recognise the repeat; it travels in operation-call's own envelope. | none |
| `request-correlation` | provides | `agp:correlation-label`, `agp:direct-peer-send`, `agp:delivery-context` | A reply or a delivery report is paired with the attempt it answers; each attempt carries its own correlation in the delivery beneath's label, so a late reply to an earlier attempt is never taken for a later one's. | none |
| `not-delivered-signal` | provides, implied by `honest-call-ending` | `agp:route-or-refuse-send`, `agp:delivery-disposition-report` | "Not delivered" is reported only when the delivery beneath refused the attempt outright, so that attempt had no effect; it proves nothing about earlier attempts of the same invocation, whose uncertainty stands. | none |
| `call-refusal` | provides | `agp:direct-peer-send`, `shape-check:plain-json-value` | When an operation refuses an invocation, the caller receives what was wrong, why, and how to fix it, in the shared refusal form, carrying any reason another component supplied unchanged; exports `readRefusalRecord`, the validator of `EM9`'s refusal form as plain data (zorg's `D54`, `D55`). | none |
| `operation-descriptions` | provides | none | Operations are declared as data - name, input shape, whether the answer comes whole or in parts - and a caller can read what a host offers. | none |
| `declared-shape-validation` | carries from shape-check | none | Input is checked against the operation's declared shape before the operation runs, and a misfit is refused. | none |
| `serve-named-operations` | provides | `agp:expose-named-endpoint`, `agp:route-or-refuse-send`, `agp:direct-peer-send`, `agp:delivery-context`, `shape-check:plain-json-value` | A host exposes declared operations by name, and every invocation gets exactly one ending even when the operation fails; what an operation handler or the host's evidence port returns, after any declared native `Promise` completion (a non-native thenable is not awaited), is read as plain data through `shape-check`'s `readPlainJson` and `observePromises` and `readRefusalRecord` (zorg's `D54`, `D55`), any non-plain result, non-native thenable or throw ending `failed` with `operation-failed` (for evidence, without running the handler, while `malformed-request` still takes precedence) and any native promises met on a result or a thrown value observed. | none |
| `peer-identity-evidence` | carries from agp | none | The operation receives the delivery beneath's evidence of who is calling. | none |
| `advertiser-instance-select` | carries from agp | none | A caller may name the instance it means; operation-call passes it on and never chooses one. | none |

operation-call holds nothing across a restart, coordinates no actors and contains no model, so none of its capabilities brings a trait.\
Under zorg's `D51`, `D59`, `D60`, `D61` and `D75` (`upstream/agp-direct-peer-send-draft-reply.md`, `docs/DELTAS/DELTA-11.md`), the host pins every reply to the request's origin node over its direct peer channel:
- At `createOperationHost(node, options)` construction, the host checks `typeof node.sendDirectPeer === "function"` (throwing `TypeError` before opening if absent, never falling back to `node.send`) and reads `options.mode` and `options.minimumProtection` once (if a getter or `Proxy` trap throws while reading `options`, any reachable native promises in the thrown value are observed through `observePromises` and the `TypeError` or thrown error is propagated): `mode` defaults to `"unauthenticated"` when omitted or `undefined` and must be `"unauthenticated"` or `"authenticated"` (else `TypeError`), and `minimumProtection` defaults to `"confidentiality-and-integrity"` when `mode === "authenticated"` and `"none"` when `mode === "unauthenticated"` when omitted or `undefined` and must be `"none"`, `"integrity"` or `"confidentiality-and-integrity"` (else `TypeError`).
- On every incoming delivery (`to`), `captureEligibleDirectPeer(to, hostMode)` reads `to.directPeer` once as plain data through `readPlainJson` and `observePromises` (`D54`, `D55`), requiring a plain object with exact keys `originNodeId` (`=== to.source.originNodeId`, non-empty string) and `authorizationAssociation` (a plain object with `mode === hostMode`: exact key `mode: "unauthenticated"` when `hostMode === "unauthenticated"`, or exact keys `mode: "authenticated"`, `issuer`, `principal` and `instanceBinding` as non-empty strings when `hostMode === "authenticated"`); if `to.directPeer` is absent, malformed, carries a getter or symbol, throws, or mismatches `to.source.originNodeId` or `hostMode`, `captureEligibleDirectPeer` returns `null`.
- On every reply branch - whole answers, `malformed-request` and `input-misfit` refusals, `<service>/describe` replies, `operation-failed` endings, the `answer-not-sendable` failed-end fallback, and the `part` and `alive` messages of an answer in parts (zorg's `D64`) - if the captured `directPeerTarget` is `null`, the host sends nothing at all (skipping both the primary send and any `answer-not-sendable` fallback, so an ineligible request never produces a send); when `directPeerTarget` is non-null, `sendTo` calls `node.sendDirectPeer("${service}/${operationName}", to.source.endpoint, message, { target: directPeerTarget, minimumProtection, ...(to.correlationId === undefined ? {} : { correlationId: to.correlationId }) })`, and in `reply()`, any non-`failed` end (`answered` or `refused`) that fails `crossesAgp(message)` is replaced before sending by `{ outcome: "failed", reason: "answer-not-sendable", agpCode: null }`, and if `node.sendDirectPeer` rejects a non-`failed` end (`answered` or `refused`), `reply()` sends at most one fallback `{ outcome: "failed", reason: "answer-not-sendable", agpCode }` using the same captured `directPeerTarget` (never retrying an already-`failed` end).

---

## Reference

This repository, `apnex/operation-call`, private until its first working code is certified.\
The package `@apnex/operation-call` exports `createCaller`, `createOperationHost`, `readCallEnding` (which reads a candidate through `readPlainJson`, checks the exact fields of one of the four `CallEnding` kinds - direct, hop or whole-find, including `attempt: null` on a whole-find `bound-passed` ending, with no single-message size or depth cap - and returns `{ok: true, ending}` deeply frozen or `{ok: false}`), `readRefusalRecord` (which reads a candidate through `readPlainJson`, checks `EM9`'s exact fields and any `SD4` `misfits`, and returns `{ok: true, refusal}` deeply frozen or `{ok: false}`), `readCallRequest` (which reads `host`, `service`, `operation`, `bound`, `invocation`, `repeat`, `signal` and `onPart` at most once each and snapshots `input` once through `snapshotJson`, throwing `EM12`'s `RangeError` or `TypeError` for any programming error and returning the validated request with the live `AbortSignal`), `systemCallClock`, `systemIdentitySource`, `MAX_BOUND_MS` and `DECLARATION_LIMITS`; `@apnex/operation-call/message-format` exports the message format and the caller's own checks; and `@apnex/operation-call/caller-suite` exports `registerCallerSuite` and `callerSuiteRows`, the caller contract suite, as `export-map.json` records.\
`answer-in-parts` and `cancel-invocation` are served - a call request's `onPart` and abort signal, an operation's `answers: "parts"` and `part`, the messages `alive` and `cancel`, and the caller suite's rows of both - built in zorg's Delta 4 under `D64`, and nothing is deferred.\
It depends on `@agp/node` and `@apnex/shape-check` through `file:` links, takes AGP's types only, and imports no module particular to one runtime.

---

## Fit criteria

### Does my project want this at all

- Parts of your system reach each other by name over one-way delivery, and you are about to write request and reply pairing, time-outs, or error shapes by hand.
- A caller must tell "it failed" from "it may have happened" - especially an agent that would repeat a write on a wrong answer.
- Some answers arrive over time, and the caller must know when such an answer is complete, broken, or abandoned.

### Does it meet my requirement

- Operations are addressed by name, never by where they run.
- Every call ends exactly once, and "unknown" is reported rather than guessed.
- Operations are described as data both sides can read.

**It is the wrong tool when**

| You need | Reach elsewhere, because operation-call is |
|---|---|
| a call that survives a restart, or delivery that is retried for you | not a store and not a retrier |
| topics, subscriptions, or one message to many callers | not a broker or a bus |
| several effects landing together or not at all | not a transaction coordinator |
| routing, reachability, or choosing among hosts | not a router; that is the delivery beneath |
| a decision about who may call what | not an authority |

---

## Adjustment policy

Internal and sovereign, so a fit gap has somewhere to go.

1. Record a measured gap where both sides can see it.
2. Resolve it by adjusting operation-call, so every consumer gets the change, or by fracturing it when the gap reveals a second duty.
3. Never fork.

The delivery beneath is reached through a port, so a new delivery layer is an adapter rather than a change to operation-call.

---

## Edges

**Composes:** nothing registered.\
Its caller side and host side are halves of one duty, not separate components.

**Consumes, through a declared contract:**

- `agp`: `expose-named-endpoint`, `route-or-refuse-send`, `direct-peer-send`, `delivery-disposition-report`, `correlation-label`, `delivery-context`, `advertiser-instance-select`, `peer-identity-evidence`
- `shape-check`: `declared-shape-validation`, `plain-json-value`

AGP's capabilities are read from zorg's `upstream/agp-capabilities.md`.\
Each attempt is paired through AGP's `correlation-label` (zorg's `D4`); a delivery layer without such a label is given one by operation-call's adapter, inside the payload.

**Composed-by:** nothing yet.\
Its first consumer, once built, is entity-api.

The registry's edge vocabulary has `composes` and `composed-by` but no edge for one component using another's contract without containing it.\
`Consumes` is written here to record that relation, and the gap is a finding for the registry.
