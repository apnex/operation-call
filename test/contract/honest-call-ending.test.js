// honest-call-ending - calling a named operation yields exactly one ending: answered, refused with a reason,
// not delivered, or unknown (zorg's target, EM11, EM12, RT7; zorg's E6).
//
// The caller suite's cases for this row run directly against operation-call's own caller, on AGP's
// production in-process carrier with AGP's injected clock and executor barrier and a separate clock for
// the call's bound: answered once; an operation that throws; answers of 30 and 31 levels and one over the
// caller's receive limit; AGP's failures as endings with AGP's code; the two clocks each passing first; a
// deadline and a cancellation after admission; and the channel lost before any report, after delivered,
// after failed, and with an answer held until reconnection and released before or after the bound.
import { test } from "node:test";
import { registerCallerSuite } from "@apnex/operation-call/caller-suite";
import { directHarness } from "../support/fixture.js";

registerCallerSuite((name, run) => test(name, { timeout: 30_000 }, run), directHarness, ["honest-call-ending"]);
