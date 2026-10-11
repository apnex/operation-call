/**
 * When an event happens (zorg's target, EM12; zorg's E6): when it occurs on the call's clock, not when a
 * callback for it runs. The bound starts when the caller invokes, so time spent preparing the request counts
 * against it; an answer, a refusal, AGP's rejection or AGP's report of failure observed once the bound has
 * passed loses to the bound, even when the bound's own timer has not yet run - deterministically, with the
 * call bound's clock moved and its callbacks held back, and on the system's own clock, with a host occupying
 * its thread past the bound. A wakeup of the bound's timer is not the bound passing either: on the system's
 * own clock, whose timer can wake before its delay has passed on the clock it reads, no call ends before its
 * bound and an answer produced just before the bound is taken. Across a hop, each schedule falls at the bound
 * the call beneath is given, the bound less the hop allowance (zorg's D46).
 */
import type { CallEnding } from "../call-types.js";
import { systemCallClock } from "../system-ports.js";
import { check, same, settle, until, watch, type Watched } from "./suite-check.js";
import { beneathBound, checkAtBound, hopAllowance, inCase, untilEndedPumping, type CaseContext } from "./suite-support.js";
import type { SuiteCase } from "./suite-types.js";

/**
 * The earliest a call of `bound` milliseconds may end at its bound on the system's own clock, from just
 * before it is invoked: the bound itself for a direct caller; across a hop, the bound the call beneath is
 * given, less the 1 ms its far side's bound loses when rounded down to a whole millisecond (PX5; zorg's D46).
 */
function earliestAtBound(c: CaseContext, bound: number): number {
	return hopAllowance(c.harness, bound) === 0 ? bound : beneathBound(c.harness, bound) - 1;
}

/**
 * The bound of a silent call on the system's own clock: 20 ms for a direct caller; across a hop, 20 ms more
 * than twice the hop's allowance, so the hop is given its whole allowance to carry the ending back.
 */
function silentBound(c: CaseContext): number {
	return hopAllowance(c.harness, 20) === 0 ? 20 : 20 + 2 * c.harness.hopAllowanceMs;
}

/** The last report of delivered or unknown the caller's node was given, or null. */
function lastReport(c: CaseContext): "delivered" | "unknown" | null {
	const last = c.hooks.reports().filter((r) => r !== "failed").at(-1);
	return last ?? null;
}

/**
 * After a call ended at the moved clock, runs every callback that fell due and the rest of the bound, and
 * checks that the ending stays exactly as it was.
 */
async function nothingAfter(c: CaseContext, call: Watched<CallEnding>, rest: number, what: string): Promise<void> {
	const ending = call.value();
	c.hooks.advanceCallClock(rest);
	c.hooks.advanceAgpClock(0);
	await settle();
	same(call.count(), 1, `${what}: one ending`);
	check(call.value() === ending, `${what}: the bound's own callback, run late, changes nothing`);
}

/** A refusal record of another part, for an operation to refuse with. */
const REFUSAL = { part: "fixture-store", code: "revision-moved", what: "The revision moved.", why: "Another write landed first.", fix: "Read again, then write.", details: {} };

export const eventTimeCases: readonly SuiteCase[] = [
	{
		name: "an answer observed once the bound has passed on the call's clock, before the bound's callback has run, loses to the bound",
		run: (h) => inCase(h, {}, async (c) => {
			const bound = 1000;
			const edge = beneathBound(c.harness, bound);
			const call = watch(c.call({ operation: "hold", bound }));
			await until(() => c.a.holds.length === 1, "the operation runs");
			c.hooks.moveCallClock(edge);
			await settle();
			check(!call.settled(), "with the bound's callback held back, nothing has ended the call");
			c.a.holds[0]?.release();
			await until(call.settled, "the ending, once the answer is observed");
			checkAtBound(call.value(), lastReport(c), "an answer observed after the bound");
			await nothingAfter(c, call, bound - edge, "an answer observed after the bound");
		}),
	},
	{
		name: "a refusal observed once the bound has passed on the call's clock, before the bound's callback has run, loses to the bound",
		run: (h) => inCase(h, {}, async (c) => {
			const bound = 1000;
			const edge = beneathBound(c.harness, bound);
			const call = watch(c.call({ operation: "hold-refuses", input: REFUSAL, bound }));
			await until(() => c.a.holds.length === 1, "the operation runs");
			c.hooks.moveCallClock(edge);
			await settle();
			check(!call.settled(), "with the bound's callback held back, nothing has ended the call");
			c.a.holds[0]?.release();
			await until(call.settled, "the ending, once the refusal is observed");
			checkAtBound(call.value(), lastReport(c), "a refusal observed after the bound");
			await nothingAfter(c, call, bound - edge, "a refusal observed after the bound");
		}),
	},
	{
		name: "AGP's rejection of a queued send observed once the bound has passed on the call's clock, before the bound's callback has run, loses to the bound",
		run: (h) => inCase(h, {}, async (c) => {
			const bound = 1000;
			const edge = beneathBound(c.harness, bound);
			const release = c.hooks.holdExecutor(c.session.callerNodeId);
			const controller = new AbortController();
			const call = watch(c.call({ operation: "which", bound, signal: controller.signal }));
			await settle();
			c.hooks.moveCallClock(edge);
			await settle();
			check(!call.settled(), "with the bound's callback held back, nothing has ended the call");
			controller.abort();
			await until(call.settled, "the ending, once AGP's rejection is observed");
			checkAtBound(call.value(), null, "AGP's rejection observed after the bound");
			await release();
			await nothingAfter(c, call, bound - edge, "AGP's rejection observed after the bound");
			same(c.a.runs.length + c.b.runs.length, 0, "the rejected request never arrived");
		}),
	},
	{
		name: "AGP's report that the request failed, observed once the bound has passed on the call's clock, before the bound's callback has run, loses to the bound",
		run: (h) => inCase(h, {}, async (c) => {
			const bound = 1000;
			const edge = beneathBound(c.harness, bound);
			const release = c.hooks.holdExecutor(c.a.nodeId);
			const closing = c.a.host.close();
			await settle();
			const call = watch(c.call({ operation: "which", bound }));
			await settle();
			c.hooks.moveCallClock(edge);
			await settle();
			check(!call.settled(), "with the bound's callback held back, nothing has ended the call");
			await release();
			await closing;
			const ending = await untilEndedPumping(c, call, "the ending, once AGP's report is observed");
			check(c.hooks.reports().includes("failed"), "AGP reported the request failed, after admitting it");
			checkAtBound(ending, null, "AGP's report of failure observed after the bound");
			await nothingAfter(c, call, bound - edge, "AGP's report of failure observed after the bound");
			same(c.a.runs.length, 0, "no handler ran");
		}),
	},
	{
		name: "on the system's own clock, an answer produced just before the bound is taken, and no call ends before its bound: a timer waking early is not the bound passing",
		run: (h) => inCase(h, { realCallClock: true }, async (c) => {
			const bound = 1000;
			const edge = beneathBound(c.harness, bound);
			// The host occupies the thread until 250 ms before the bound the call beneath is given, then answers:
			// the request's way there and the answer's way back are given room enough on a loaded machine, and
			// the bound's timer, which cannot run while the thread is occupied, wakes only after the answer.
			const ms = edge - 250;
			for (let i = 0; i < 3; i++) {
				const start = systemCallClock.now();
				const ending = await c.ended({ operation: "busy", input: { ms }, bound });
				const elapsed = systemCallClock.now() - start;
				same(ending.ending, "answered", `call ${i + 1}: the answer produced ${ms} ms into a call of ${bound} ms is taken`);
				same(ending.ending === "answered" ? ending.answer : undefined, ms, `call ${i + 1}: the answer`);
				check(elapsed >= ms, `call ${i + 1}: the answer came after the host answered, at ${elapsed} ms`);
			}
			const silent = silentBound(c);
			const earliest = earliestAtBound(c, silent);
			// Fewer calls for a longer bound, so a hop with a long allowance stays within a case's time.
			for (let i = 0, calls = Math.min(10, Math.max(3, Math.floor(1000 / silent))); i < calls; i++) {
				const start = systemCallClock.now();
				const ending = await c.ended({ operation: "silent", bound: silent });
				const elapsed = systemCallClock.now() - start;
				same([ending.ending, ending.ending === "unknown" ? ending.reason : undefined], ["unknown", "bound-passed"], `silent call ${i + 1}: the ending at the bound`);
				check(elapsed >= earliest, `silent call ${i + 1} of ${silent} ms not to end before ${earliest} ms, but it ended at ${elapsed} ms`);
			}
		}),
	},
];

export const preparationTimeCases: readonly SuiteCase[] = [
	{
		name: "time passing on the call's clock while the caller prepares the invocation counts against the bound, which starts when the caller invokes",
		run: (h) => inCase(h, {}, async (c) => {
			const bound = 100;
			const edge = beneathBound(c.harness, bound);
			// Less than the bound the call beneath is given, which is at least half the bound.
			const preparing = 30;
			let read = false;
			const input = {
				get prepared(): string {
					if (!read) {
						read = true;
						c.hooks.moveCallClock(preparing);
					}
					return "yes";
				},
			};
			const call = watch(c.call({ operation: "silent", input: input as never, bound }));
			await until(() => c.a.runs.length === 1, "the operation runs");
			check(read, "the caller read its input while preparing the invocation");
			same(c.a.runs[0]?.input, { prepared: "yes" }, "the input as the caller read it");
			c.hooks.advanceCallClock(edge - preparing - 1);
			await settle();
			check(!call.settled(), `nothing ends the call 1 ms before ${edge} ms from invoking`);
			c.hooks.advanceCallClock(1);
			await until(call.settled, `the ending ${edge} ms from invoking, the preparing included`);
			checkAtBound(call.value(), lastReport(c), "a bound with part of it spent preparing");
			await nothingAfter(c, call, bound - edge, "a bound with part of it spent preparing");
		}),
	},
	{
		name: "on the system's own clock, an admitted invocation whose operation never answers never ends before its bound, a timer waking early on the clock it reads included",
		run: (h) => inCase(h, { realCallClock: true }, async (c) => {
			const bound = silentBound(c);
			const earliest = earliestAtBound(c, bound);
			// Fewer calls for a longer bound, so a hop with a long allowance stays within a case's time.
			for (let i = 0, calls = Math.min(25, Math.max(5, Math.floor(2500 / bound))); i < calls; i++) {
				const start = systemCallClock.now();
				const ending = await c.ended({ operation: "silent", bound });
				const elapsed = systemCallClock.now() - start;
				same(c.a.runs.length, i + 1, `call ${i + 1}: the operation ran`);
				same([ending.ending, ending.ending === "unknown" ? ending.reason : undefined, ending.ending === "unknown" ? ending.agpCode : undefined], ["unknown", "bound-passed", null], `call ${i + 1}: the ending at the bound`);
				check(elapsed >= earliest, `call ${i + 1} of ${bound} ms not to end before ${earliest} ms, but it ended at ${elapsed} ms`);
			}
		}),
	},
	{
		name: "on the system's own clock, an answer produced after the bound, its host occupying the thread past it, loses to the bound",
		run: (h) => inCase(h, { realCallClock: true }, async (c) => {
			const bound = 200;
			const allowance = hopAllowance(c.harness, bound);
			// Past the bound the call beneath is given, and across a hop well within the allowance after it.
			const ms = bound - allowance + (allowance > 0 ? Math.floor(allowance / 2) : 20);
			const ending = await c.ended({ operation: "busy", input: { ms }, bound });
			same(c.a.runs.length, 1, "the operation ran");
			check(ending.ending === "unknown", `the answer, produced ${ms} ms after a call of ${bound} ms began, is not taken: ${ending.ending}`);
			same(ending.reason, "bound-passed", "the reason");
			same(ending.agpCode, null, "no AGP code");
		}),
	},
];
