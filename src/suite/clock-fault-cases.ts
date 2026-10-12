/**
 * honest-call-ending, when the clock port of the caller under test fails (zorg's target, EM12): a clock port
 * that throws is a fault of the port, and the event the caller observed then decides. For each event that
 * can decide an invocation - an answer, a refusal, a refusal before anything reaches a host, and the bound -
 * the port throws once, at the reading or at the timer's cancellation that comes as that event decides, and
 * the invocation still ends exactly once, frozen, as that event decides it, leaving nothing held or waiting
 * and no rejection unhandled. The fault is the caller under test's own port - operation-call's caller's in a
 * direct harness, the client half's across a hop, never that of the call layer beneath it - and each case
 * checks that the fault reached that port.
 */
import type { CallEnding } from "../call-types.js";
import { check, same, settle, until, watch, type Watched } from "./suite-check.js";
import { checkAtBound, checkEndingFields, checkNotDelivered, inCase, runOutBound, untilEndedPumping, type CaseContext } from "./suite-support.js";
import type { SuiteCase } from "./suite-types.js";

/** Where the clock port throws. */
type ClockFault = "read" | "cancel";

/** The words for each fault. */
const AT: { readonly [at in ClockFault]: string } = { read: "a reading", cancel: "a timer's cancellation" };

/** A refusal record of another part, for an operation to refuse with. */
const REFUSAL = { part: "fixture-store", code: "revision-moved", what: "The revision moved.", why: "Another write landed first.", fix: "Read again, then write.", details: {} };

/** The last report of delivered or unknown the caller's node was given, or null. */
function lastReport(c: CaseContext): "delivered" | "unknown" | null {
	return c.hooks.reports().filter((r) => r !== "failed").at(-1) ?? null;
}

/**
 * After a call ended as its clock port threw: runs the call bound's clock well past the bound and AGP's due
 * work, and checks that the ending stays the one frozen ending it was, that the fault reached the port of the
 * caller under test, and that nothing is left held or waiting and no rejection unhandled.
 */
async function nothingLeft(c: CaseContext, call: Watched<CallEnding>, at: ClockFault, what: string): Promise<void> {
	const ending = call.value();
	c.hooks.advanceCallClock(3000);
	c.hooks.advanceAgpClock(0);
	await settle();
	same(call.count(), 1, `${what}: one ending`);
	check(call.value() === ending, `${what}: the ending unchanged, every timer run`);
	check(Object.isFrozen(ending), `${what}: the ending is frozen`);
	same(c.hooks.callClockFaults(), [at], `${what}: the clock port of the caller under test threw at ${AT[at]}, once`);
	same(c.hooks.outstanding(), 0, `${what}: nothing left held or waiting`);
	same(c.hooks.unhandled().length, 0, `${what}: no rejection unhandled and no exception uncaught`);
}

/** The cases for a clock port that throws at `at`. */
function casesAt(at: ClockFault): SuiteCase[] {
	return [
		{
			name: `a clock port that throws at ${AT[at]} as an answer decides is a fault of the port: the answer is the one frozen ending, nothing is left held or waiting, and no rejection goes unhandled`,
			run: (h) => inCase(h, {}, async (c) => {
				const what = `an answer, the port throwing at ${AT[at]}`;
				const call = watch(c.call({ operation: "hold", input: { n: 1 }, bound: 1000 }));
				await until(() => c.a.holds.length === 1, "the operation runs");
				await settle();
				c.hooks.failCallClock(at);
				c.a.holds[0]?.release();
				await until(call.settled, `${what}: the ending`);
				const ending = call.value();
				checkEndingFields(ending, what);
				same(ending?.ending, "answered", `${what}: the observed answer decides`);
				if (ending?.ending === "answered") same((ending.answer as { input?: unknown }).input, { n: 1 }, `${what}: the answer`);
				await nothingLeft(c, call, at, what);
			}),
		},
		{
			name: `a clock port that throws at ${AT[at]} as an operation's refusal decides is a fault of the port: the refusal is the one frozen ending, nothing is left held or waiting, and no rejection goes unhandled`,
			run: (h) => inCase(h, {}, async (c) => {
				const what = `a refusal, the port throwing at ${AT[at]}`;
				const call = watch(c.call({ operation: "hold-refuses", input: REFUSAL, bound: 1000 }));
				await until(() => c.a.holds.length === 1, "the operation runs");
				await settle();
				c.hooks.failCallClock(at);
				c.a.holds[0]?.release();
				await until(call.settled, `${what}: the ending`);
				const ending = call.value();
				checkEndingFields(ending, what);
				same(ending?.ending, "refused", `${what}: the observed refusal decides`);
				if (ending?.ending === "refused") same(ending.refusal, REFUSAL, `${what}: the refusal, unchanged`);
				await nothingLeft(c, call, at, what);
			}),
		},
		{
			name: `a clock port that throws at ${AT[at]} as a refusal before anything reaches a host decides - the caller's preparing refused, where it prepares, otherwise AGP's refusal of the send - is a fault of the port: not delivered is the one frozen ending, nothing is left held or waiting, and no rejection goes unhandled`,
			run: (h) => inCase(h, {}, async (c) => {
				const code = c.hooks.refuseNextPreparing?.();
				const what = `${code === undefined ? "AGP's refusal of the send" : "a refusal of preparing"}, the port throwing at ${AT[at]}`;
				const call = watch(code === undefined ? c.call({ operation: "which", host: "fixture-absent-node" }) : c.call({ operation: "which" }));
				c.hooks.failCallClock(at);
				const ending = await untilEndedPumping(c, call, `${what}: the ending`);
				if (code === undefined) {
					checkEndingFields(ending, what);
					checkNotDelivered(ending, ["INSTANCE_UNREACHABLE", "NO_ROUTE"], false, what);
				} else {
					same(ending.ending, "not-delivered", `${what}: the observed refusal decides`);
					same(Object.keys(ending).sort(), ["agpCode", "attempt", "earlierAttemptsUncertain", "ending", "invocation", "operation", "proxyCode"], `${what}: exactly the fields of a not-delivered ending`);
					if (ending.ending === "not-delivered") {
						same([ending.proxyCode, ending.agpCode, ending.attempt, ending.earlierAttemptsUncertain], [code, null, null, false], `${what}: the caller's code, no AGP code and no attempt`);
					}
					same(c.hooks.requests(), 0, `${what}: nothing was sent`);
				}
				same(c.a.runs.length + c.b.runs.length, 0, `${what}: no host handled it`);
				await nothingLeft(c, call, at, what);
			}),
		},
		{
			name: `a clock port that throws at ${AT[at]} as the bound decides is a fault of the port: unknown with bound-passed is the one frozen ending, nothing is left held or waiting, and no rejection goes unhandled`,
			run: (h) => inCase(h, {}, async (c) => {
				const what = `the bound, the port throwing at ${AT[at]}`;
				const bound = 1000;
				const call = watch(c.call({ operation: "silent", bound }));
				await until(() => c.a.runs.length === 1, "the operation runs");
				await settle();
				c.hooks.failCallClock(at);
				const ending = await runOutBound(c, call, bound, { waits: `${what}: nothing ends the call before its bound`, ending: `${what}: the ending at the bound` });
				checkEndingFields(ending, what);
				checkAtBound(ending, lastReport(c), what);
				await nothingLeft(c, call, at, what);
			}),
		},
	];
}

export const clockFaultCases: readonly SuiteCase[] = [...casesAt("read"), ...casesAt("cancel")];
