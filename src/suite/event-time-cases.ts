/**
 * When an event happens (zorg's target, EM12; zorg's E6, D6-E1): when it occurs on the call's clock, not when
 * a callback for it runs. The bound starts when the caller invokes, so time spent preparing the request counts
 * against it; an answer, a refusal, AGP's rejection or AGP's report of failure observed once the bound has
 * passed loses to the bound, even when the bound's own timer has not yet run - deterministically, with the
 * call bound's clock moved and its callbacks held back, including when a synchronous host operation (`busy`)
 * moves the clock while occupying the thread past the bound (`BL27`). A wakeup of the bound's timer is not the
 * bound passing either: on the system's own clock an answer produced before the bound while the host occupied
 * the thread is taken, and on the controlled clock with timers waking `0.5` ms before their delay has passed
 * (`earlyWakeMs: 0.5`) the timer re-arms for the `1` ms remaining and no call ends before its bound. Across a
 * hop, each schedule falls at the bound the call beneath is given, the bound less the hop allowance (`D46`).
 */
import type { CallEnding } from "../call-types.js";
import { systemCallClock } from "../system-ports.js";
import { check, same, settle, until, watch, type Watched } from "./suite-check.js";
import { beneathBound, checkAtBound, hopAllowance, inCase, untilEndedPumping, type CaseContext } from "./suite-support.js";
import type { SuiteCase } from "./suite-types.js";

/** The last report of delivered or unknown the caller's node was given, or null. */
function lastReport(c: CaseContext): "delivered" | "unknown" | null {
	const last = c.hooks.reports().filter((r) => r !== "failed").at(-1);
	return last ?? null;
}

/**
 * Checks that a `silent` call of `bound = 100` in an `earlyWakeMs: 0.5` session wakes early at `edge - 0.5`,
 * re-arms for `1` ms without ending at `edge - 0.25`, and ends `unknown` with `bound-passed` once the clock
 * reaches `edge` (EM12; D6-E1).
 */
async function checkEarlyWakingSilent(c: CaseContext, what: string): Promise<void> {
	const bound = 100;
	const edge = beneathBound(c.harness, bound);
	const call = watch(c.call({ operation: "silent", bound }));
	await until(() => c.a.runs.length === 1, `${what}: the operation runs`);
	c.hooks.advanceCallClock(edge - 0.25);
	await settle();
	const delays = (c.hooks.callClock() as { readonly delays?: readonly number[] }).delays;
	check(Array.isArray(delays) && delays.includes(1), `${what}: the early wakeup at ${edge - 0.5} ms re-armed the timer for 1 ms`);
	check(!call.settled(), `${what}: after the early wakeup at ${edge - 0.5} ms, the call is still waiting at ${edge - 0.25} ms`);
	c.hooks.advanceCallClock(0.25);
	await until(call.settled, `${what}: the ending once the clock reaches ${edge} ms`);
	checkAtBound(call.value(), lastReport(c), what);
	await nothingAfter(c, call, bound - edge, what);
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
		run: async (h) => {
			await inCase(h, { realCallClock: true }, async (c) => {
				const bound = 2000;
				const edge = beneathBound(c.harness, bound);
				// The host occupies the thread for 200 ms of a 2000 ms bound (1750 ms before edge across a 50 ms
				// hop, 1800 ms directly), then answers, leaving wide room on a loaded machine.
				const ms = 200;
				check(ms < edge, `the busy duration ${ms} ms lies before ${edge} ms`);
				for (let i = 0; i < 3; i++) {
					const start = systemCallClock.now();
					const ending = await c.ended({ operation: "busy", input: { ms }, bound });
					const elapsed = systemCallClock.now() - start;
					same(ending.ending, "answered", `call ${i + 1}: the answer produced ${ms} ms into a call of ${bound} ms is taken`);
					same(ending.ending === "answered" ? ending.answer : undefined, ms, `call ${i + 1}: the answer`);
					check(elapsed >= ms, `call ${i + 1}: the answer came after the host answered, at ${elapsed} ms`);
				}
			});
			await inCase(h, { earlyWakeMs: 0.5 }, (c) => checkEarlyWakingSilent(c, "a silent call with an early-waking timer"));
		},
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
		run: (h) => inCase(h, { earlyWakeMs: 0.5 }, (c) => checkEarlyWakingSilent(c, "an admitted silent call with an early-waking timer")),
	},
	{
		name: "on the system's own clock, an answer produced after the bound, its host occupying the thread past it, loses to the bound",
		run: (h) => inCase(h, {}, async (c) => {
			const bound = 200;
			const allowance = hopAllowance(c.harness, bound);
			// Past the bound the call beneath is given, and across a hop well within the allowance after it.
			const ms = bound - allowance + (allowance > 0 ? Math.floor(allowance / 2) : 20);
			const call = watch(c.call({ operation: "busy", input: { ms }, bound }));
			await until(call.settled, "the ending, once the synchronous answer after the bound is observed");
			same(c.a.runs.length, 1, "the operation ran");
			checkAtBound(call.value(), lastReport(c), "an answer produced after the bound while the host occupied the thread");
			await nothingAfter(c, call, Math.max(0, bound - ms), "an answer produced after the bound while the host occupied the thread");
		}),
	},
];
