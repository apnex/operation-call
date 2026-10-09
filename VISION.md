# opcall - Vision

**Status: ratified by the director, 2026-10-09 (`docs/DECISIONS.md`, `D5`); enduring.**\
This document states why opcall exists and what it will never be.\
It carries no current state, no roadmap, and no schedule.

Holding this document authorises nothing.\
It does not ratify a decision, admit a component to any registry, or approve a contract change.\
A change of direction is recorded as a decision first and absorbed here afterwards.

---

## North star

> Let any component invoke a named operation on any other and always learn, within a bound it chose, how that invocation ended - including when the honest answer is that it cannot be known.

Four terms in that sentence carry weight, so this document defines them rather than leaving them to the reader.

**Named operation** means a capability addressed by what it does, never by where it runs.\
Finding where it runs belongs to the delivery beneath.\
A caller may still name which instance it means; opcall passes that on and never chooses one itself.

**Invocation** means one caller asking one operation once, under one identity, for one outcome - what SIP calls a transaction.\
Its answer may arrive whole or in ordered parts; either way it ends exactly once.\
A caller may end an invocation before it is complete; the operation is told, and parts already received stand.

**How it ended** is one of four things, and which one is never guessed:

- answered;
- refused by the operation, with its reason;
- not delivered - the delivery beneath refused it outright, so repeating it is safe;
- unknown - it may have reached the operation, and no answer came within the bound.

Anything less certain than an outright refusal is unknown, never not delivered.\
An answer arriving in parts that stops before its end ends as unknown; the parts already received stand.

**A bound it chose** means the caller, not the operation or the network, decides how long it waits: for the end, or, for an answer arriving in parts, for the next sign of life.

---

## Why it exists

Delivery that is one-way and addressed by name is the right floor.\
It refuses what it cannot route and promises nothing it cannot keep.\
Almost every use of it, though, wants an answer.

Without a shared layer, every application rebuilds the same machinery: pairing a reply with its request, timing out, shaping errors.\
It rebuilds the hardest part worst, which is telling "it failed" from "it may have happened".\
An agent told "failed" when the truth is "unknown" repeats a write that already landed.

Existing request-response frameworks need an address and a connection before they start.\
Instead, opcall keeps addressing by name, and adds an answer and an honest ending.

---

## What it is

A library on named one-way delivery that gives each side of a call what it needs: the caller an outcome, and the operation a well-formed request and a way to answer.

Operations are described as data, so both sides agree on what exists and what it accepts before anything is sent.

It is embedded by an application that owns its own process, configuration, and deployment.

---

## What it is not

**Not a router.**\
It never decides where an operation runs or whether it is reachable.\
It may ask the delivery beneath; it never answers for it.

**Not a store.**\
It holds nothing that must survive a restart.\
An invocation in flight when the operation's process stops ends, for its caller, as unknown.

**Not a guarantor of effects.**\
It does not promise that an effect happens once.\
It gives a repeated invocation the same identity, so whatever owns the effect can recognise the repeat; recognising it is the owner's job.

**Not a retrier.**\
It never repeats an invocation on its own.\
The caller decides whether to repeat; opcall tells it when repeating is safe.

**Not a broker or a bus.**\
There are no topics, no subscriptions, and no fan-out.\
A stream of parts goes to the one caller that asked; reaching many callers is many invocations.

**Not a transaction coordinator.**\
An invocation has one outcome.\
Making several effects land together, or not at all, belongs to whatever owns those effects.

**Not an authority.**\
It passes on the evidence of who is calling.\
Deciding what that caller may do belongs to the application.

**Not agentic.**\
It carries calls for agentic systems and contains no cognition, model, or orchestration.

---

## What success means

Four dimensions.\
They are not weighted, and they do not collapse.

**Honest endings.**\
Every invocation ends exactly once, within its bound, in the outcome that is true.\
The measure is that loss, restart, and partition produce more unknowns - never a hang, a second ending, or an unknown reported as an answer or a failure.

**Leanness.**\
It adds little to the delivery beneath: in time, in bytes on the wire, and in code a reader must hold.\
The measure is the overhead of an invocation against the send beneath it, stated and small.

**Legibility.**\
A caller, often an agent, can learn what operations exist, what each accepts, what an outcome means, and what to do next, without reading source.\
The measure is that every refusal carries enough to act on.

**Reuse.**\
A second, unrelated application adopts it without a variant, a fork, or a privileged path.\
The delivery beneath can be replaced without the applications above noticing.

A programme strong on three of these and weak on one has one unmet dimension, and which one it is says more than any average of the four.

---

## Authority

Held by the director.\
Drafted by anyone; ratified only by the director.

This statement is amended, never quietly rewritten.\
A ruling that changes direction is recorded as a decision and absorbed here, so the reasoning survives the change.

Where this narrative and a verified record disagree about state, the record governs.
