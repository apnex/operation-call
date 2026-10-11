/**
 * When an event happens (zorg's target, EM12; zorg's E6): when it occurs on the call's clock, not when a
 * callback for it runs. The bound starts when the caller invokes, so time spent preparing the request counts
 * against it; an answer, a refusal, AGP's rejection or AGP's report of failure observed once the bound has
 * passed loses to the bound, even when the bound's own timer has not yet run - deterministically, with the
 * call bound's clock moved and its callbacks held back, and on the system's own clock, with a host occupying
 * its thread past the bound. Across a hop, each schedule falls at the bound the call beneath is given, the
 * bound less the hop allowance (zorg's D46).
 */
import type { CallEnding } from "../call-types.js";
import { check, same, settle, until, watch, type Watched } from "./suite-check.js";
import { beneathBound, checkAtBound, hopAllowance, inCase, untilEndedPumping, type CaseContext } from "./suite-support.js";
import type { SuiteCase } from "./suite-types.js";

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
