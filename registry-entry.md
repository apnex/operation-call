---
id: unminted
category: component
title: opcall - named operations with an honest ending over one-way delivery
status: draft
hydrate-when: Parts of your system call each other by name, and a caller must know how each call ended, including when that cannot be known
sovereignty: internal
supersedes: []
related: [C0, C1, A3]
---

# opcall

Draft registry entry, written before any consumer's architecture so that its contract states the whole offer.\
The id is unminted on purpose; one is minted only when the entry is admitted to the registry.

---

## Duty

Give every invocation of a named operation exactly one honest ending, within a bound its caller chose.

---

## Contract

What a consumer can depend on.\
Each row is one feature; the census counts rows, and the trait column names any trait a system takes on by using the feature.

| Feature | What a consumer can depend on | Trait |
|---|---|---|
| `opcall.invoke` | Calling a named operation yields exactly one ending: answered, refused with a reason, not delivered, or unknown. | none |
| `opcall.bound` | The caller sets the bound: total time for a whole answer, time to the next sign of life for an answer in parts. | none |
| `opcall.parts` | An answer may arrive as ordered parts; a missing part, or a stop before the end, ends the invocation as unknown, and parts already received stand. | none |
| `opcall.cancel` | A caller may end an invocation early, and the operation is told. | none |
| `opcall.identity` | Every invocation carries an identity, and a repeat may reuse it so the owner of an effect can recognise it. | none |
| `opcall.not-delivered` | "Not delivered" is reported only when the delivery beneath refused outright, so repeating is then safe. | none |
| `opcall.refusal` | A refusal states what was wrong, why, and how to fix it. | none |
| `opcall.describe` | Operations are declared as data - name, input shape, whether the answer comes whole or in parts - and a caller can read what a host offers. | none |
| `opcall.serve` | A host exposes declared operations by name; input is checked before the operation runs, and every invocation gets exactly one ending even when the operation fails. | none |
| `opcall.caller-evidence` | The operation receives the delivery beneath's evidence of who is calling. | none |
| `opcall.instance` | A caller may name the instance it means; opcall passes it on and never chooses one. | none |

opcall holds nothing across a restart, coordinates no actors and contains no model, so none of its features brings a trait.

---

## Reference

Not yet built.\
Vision: `opcall/VISION.md` in the zorg repository, which will hold the implementation until the component earns a repository of its own.

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

| You need | Reach elsewhere, because opcall is |
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
2. Resolve it by adjusting opcall, so every consumer gets the change, or by fracturing it when the gap reveals a second duty.
3. Never fork.

The delivery beneath is reached through a port, so a new delivery layer is an adapter rather than a change to opcall.

---

## Edges

**Composes:** nothing registered.\
Its caller side and host side are halves of one duty, not separate components.

**Consumes, through a declared contract:** AGP - `agp.expose`, `agp.send`, `agp.disposition`, `agp.instance-select` and `agp.identity` (see `upstream/agp-features.md`).

**Composed-by:** nothing yet.\
entityapi consumes it once built.

The registry's edge vocabulary has `composes` and `composed-by` but no edge for one component using another's contract without containing it.\
`Consumes` is written here to record that relation, and the gap is a finding for the registry.
