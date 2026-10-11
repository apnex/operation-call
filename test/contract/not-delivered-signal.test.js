// not-delivered-signal - "not delivered" is reported only when AGP refused the attempt outright, so that
// attempt had no effect; it proves nothing about earlier attempts of the same invocation, whose
// uncertainty stands (zorg's target, EM12; operation-call's D2; zorg's E6, AGP's second, fourth and fifth
// consumer-handoff cases).
//
// The caller suite's cases for this row run directly against operation-call's own caller: an admission
// deadline passing, and a cancellation, while the send is queued behind AGP's executor, after which the
// request never arrives; a route observed reachable and withdrawn before the send; an unknown attempt
// followed by one refused outright, its uncertainty standing; a named invocation that is no repeat; and a
// request over the peer's receive limit beside other calls; a repeat flag that is not a boolean, thrown with
// nothing sent; the exact fields of a not-delivered ending, frozen, fresh and repeated; and a send rejected
// with no AGP code, recorded with INTERNAL.
import { test } from "node:test";
import { registerCallerSuite } from "@apnex/operation-call/caller-suite";
import { directHarness } from "../support/fixture.js";

registerCallerSuite((name, run) => test(name, { timeout: 30_000 }, run), directHarness, ["not-delivered-signal"]);
