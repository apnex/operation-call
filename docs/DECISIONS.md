# Decisions

One ruling per entry, append-only.\
A ruling is never edited; a later one supersedes it and says so.

Rulings that shape this component together with others are held in zorg's `docs/DECISIONS.md`, and cited here as "zorg's `Dn`".

---

## D1 - The component stands in its own repository

**Ruled by:** the director, 2026-10-09 (zorg's `D16`).\
**Affects:** this repository.

**Ruling.**\
This component was split out of zorg with the history of its vision and contract, and is private until its first working code.\
Its vision was ratified by zorg's `D5`, and its contract of record is `CONTRACT.md` (zorg's `D17`).

**Why.**\
Each component holds its own boundary and its own history from the start, as zorg's `D10` intends.

---

## D2 - A refusal proves one attempt, not the invocation

**Ruled by:** the director, 2026-10-09.\
**Affects:** `VISION.md` (*How it ended*, *Not a retrier*), `CONTRACT.md` (`not-delivered-signal`).

**Ruling.**\
"Not delivered" says that the delivery beneath refused this attempt outright, so it had no effect.\
It proves nothing about an earlier attempt of the same invocation: if that one ended unknown, its uncertainty stands, and whether repeating is safe is for whatever owns the effect to decide.

**Why.**\
AGP found that the earlier wording - "so repeating it is safe" - overreached: one attempt can end unknown, having taken effect, and a later attempt of the same invocation can then be refused outright (AGP's `D31`, and its handoff case 5).\
This is the first amendment of the ratified vision; it narrows a promise to what can be kept, and changes no direction.

**Alternatives weighed.**\
Correcting only the contract, leaving the vision promising what the contract denies; deferring until the component is built.

---

## D3 - Renamed operation-call

**Ruled by:** the director, 2026-10-09 (zorg's `D18`).\
**Affects:** this repository, its package, `VISION.md`, `CONTRACT.md` and `README.md`.

**Ruling.**\
The component formerly named opcall is named operation-call, in hyphenated whole words like every other name in the workspace; its repository is `apnex/operation-call`, and GitHub redirects the old name.\
Earlier entries keep the name they were written with.
