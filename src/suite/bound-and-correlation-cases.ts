/**
 * caller-chosen-bound and request-correlation (zorg's target, EM11 and EM12; zorg's E6, AGP's third
 * consumer-handoff case): the bound runs on the caller's clock and ends an unanswered call exactly once;
 * each attempt is paired with its replies through its own correlation label, so a late reply to an earlier
 * attempt never completes a later one, and no delivery report is taken for an answer.
 */
import type { AgpNode } from "@agp/node";
import type { CallEnding } from "../call-types.js";
import { writeEnd, writePart, REPLY_ENDPOINT } from "../message-format.js";
import { check, same, settle, until, watch } from "./suite-check.js";
import { beneathBound, checkAtBound, checkNotDelivered, discardedCount, inCase, runOutBound, SERVICE } from "./suite-support.js";
import type { SuiteCase } from "./suite-types.js";

export const callerChosenBoundCases: readonly SuiteCase[] = [
	{
		name: "an admitted invocation whose operation never answers ends unknown exactly once at the caller's bound, and a later answer does not change that",
		run: (h) => inCase(h, {}, async (c) => {
			const call = watch(c.call({ operation: "hold", bound: 500 }));
			await until(() => c.a.holds.length === 1, "the operation runs");
			await runOutBound(c, call, 500, { waits: "no ending before the bound", ending: "the ending at the bound" });
			const last = c.hooks.reports().at(-1);
			checkAtBound(call.value(), last === "delivered" || last === "unknown" ? last : null, "an operation that never answered");
			const ending = call.value();
			const before = discardedCount(c);
			c.a.holds[0]?.release();
			if (before !== undefined) await until(() => (discardedCount(c) ?? 0) > before, "the later answer arrives and is discarded");
			c.hooks.advanceCallClock(10000);
			await settle();
			same(call.count(), 1, "exactly one ending");
			same(call.value(), ending, "the later answer changes nothing");
		}),
	},
	{
		name: "the bound runs on the caller's clock, not AGP's",
		run: (h) => inCase(h, {}, async (c) => {
			const call = watch(c.call({ operation: "silent", bound: 50 }));
			await until(() => c.a.runs.length === 1, "the operation runs");
			c.hooks.advanceAgpClock(10000);
			await settle();
			check(!call.settled(), "AGP's clock passing the bound ends nothing");
			const ending = await runOutBound(c, call, 50, { ending: "the ending at the bound" });
			same(ending?.ending, "unknown", "the call's own clock decides the bound");
			if (ending?.ending === "unknown") same(ending.reason, "bound-passed", "the reason");
		}),
	},
	{
		name: "AGP is given the time left on the bound as the send's admission deadline, the bound less the hop allowance across a hop",
		run: (h) => inCase(h, {}, async (c) => {
			const bound = 100;
			// The time the call beneath is given (zorg's D46): the bound itself for a direct caller.
			const admission = beneathBound(c.harness, bound);
			const release = c.hooks.holdExecutor(c.session.callerNodeId);
			const call = watch(c.call({ operation: "which", bound }));
			await settle();
			c.hooks.advanceAgpClock(admission - 1);
			await settle();
			check(!call.settled(), `the admission deadline has not passed after ${admission - 1} ms of AGP's clock`);
			c.hooks.advanceAgpClock(1);
			await until(call.settled, `AGP's refusal at ${admission} ms`);
			checkNotDelivered(call.value(), ["TIMEOUT"], false, `the admission deadline of ${admission} ms`);
			await release();
			c.hooks.advanceAgpClock(0);
			await settle();
			same(c.a.runs.length, 0, "the refused request never arrived after the queue drained");
		}),
	},
	{
		name: "the largest bound, 2147483647 ms, and the smallest, 1 ms, are each a call's bound",
		run: (h) => inCase(h, {}, async (c) => {
			same((await c.ended({ operation: "echo", input: "largest", bound: 2147483647 })).ending, "answered", "the largest bound");
			same((await c.ended({ operation: "echo", input: "smallest", bound: 1 })).ending, "answered", "the smallest bound, with no time passing");
		}),
	},
];

export const requestCorrelationCases: readonly SuiteCase[] = [
	{
		name: "a late reply to an earlier attempt never completes a later attempt of the same invocation",
		run: (h) => inCase(h, {}, async (c) => {
			const first = watch(c.call({ operation: "hold", bound: 100 }));
			await until(() => c.a.holds.length === 1, "the first attempt runs");
			const one = await runOutBound(c, first, 100, { ending: "the first attempt's ending" }) as CallEnding;
			checkAtBound(one, null, "the first attempt");
			const second = watch(c.call({ operation: "hold", bound: 1000, invocation: one.invocation, repeat: true }));
			await until(() => c.a.holds.length === 2, "the second attempt runs");
			const before = discardedCount(c);
			c.a.holds[0]?.release();
			if (before !== undefined) await until(() => (discardedCount(c) ?? 0) > before, "the first attempt's reply arrives and is discarded");
			await settle();
			check(!second.settled(), "the earlier attempt's reply does not complete the later one");
			c.a.holds[1]?.release();
			await until(second.settled, "the second attempt's answer");
			const two = second.value() as CallEnding;
			same(two.ending, "answered", "the second attempt's own answer");
			same(two.invocation, one.invocation, "one invocation");
			check(two.attempt !== one.attempt, "a new attempt identity");
			if (two.ending === "answered") same((two.answer as { attempt: string }).attempt, two.attempt, "the answer is the second attempt's");
		}),
	},
	{
		name: "no delivery report is taken for an answer: a report of delivered leaves the call waiting until its bound",
		run: (h) => inCase(h, {}, async (c) => {
			const call = watch(c.call({ operation: "silent", bound: 1000 }));
			await until(() => c.a.runs.length === 1, "the operation runs");
			for (let i = 0; i < 4000 && !c.hooks.reports().includes("delivered"); i++) {
				c.hooks.advanceAgpClock(0);
				await settle(1);
			}
			check(c.hooks.reports().includes("delivered"), "AGP reports the request delivered");
			await settle();
			check(!call.settled(), "the report is not an answer");
			await runOutBound(c, call, 1000, { ending: "the ending at the bound" });
			checkAtBound(call.value(), "delivered", "a delivered request with no answer");
		}),
	},
	{
		name: "each attempt's identity is AGP's correlation label for its request and its answer",
		run: (h) => inCase(h, {}, async (c) => {
			const ending = await c.ended({ operation: "which" });
			same(ending.ending, "answered", "the ending");
			const run = c.a.runs[0];
			check(run !== undefined, "the operation ran");
			same(run.correlationId, ending.attempt, "the request's correlation label is the attempt identity");
			same(run.attempt, ending.attempt, "the operation was given the same attempt");
			same(run.origin, c.session.callerNodeId, "the request came from the caller's node");
		}),
	},
	{
		name: "a message from another node, another endpoint or operation, under another label, out of form, or a part, is discarded",
		run: (h) => inCase(h, {}, async (c) => {
			const call = watch(c.call({ operation: "hold", bound: 1000 }));
			await until(() => c.a.holds.length === 1, "the operation runs");
			const { invocation, attempt } = c.a.runs[0] as { invocation: string; attempt: string };
			const address = { invocation, attempt, operation: "hold" };
			const good = writeEnd(address, { outcome: "answered", answer: "forged" });
			const toCaller = { destinationSelector: { originNodeId: c.session.callerNodeId as never, mode: "pinned" as const } };
			const forge = async (node: AgpNode, from: string, message: unknown, label: string): Promise<void> => {
				await node.send(from as never, REPLY_ENDPOINT as never, message as never, { ...toCaller, correlationId: label as never });
			};
			const [ha, hb] = c.session.hosts;
			await forge(hb.node, `${SERVICE}/hold`, good, attempt);
			await forge(ha.node, `${SERVICE}/echo`, good, attempt);
			await forge(ha.node, `${SERVICE}/hold`, writeEnd({ ...address, operation: "echo" }, { outcome: "answered", answer: "forged" }), attempt);
			await forge(ha.node, `${SERVICE}/hold`, good, `${invocation}.00000000` === attempt ? `${invocation}.11111111` : `${invocation}.00000000`);
			await forge(ha.node, `${SERVICE}/hold`, { ...good, extra: true }, attempt);
			await forge(ha.node, `${SERVICE}/hold`, writePart(address, 1, "a part"), attempt);
			await settle(40);
			check(!call.settled(), "no forged or mismatched message ends the call");
			c.a.holds[0]?.release();
			await until(call.settled, "the real answer");
			const ending = call.value() as CallEnding;
			same(ending.ending, "answered", "the operation's own answer");
			if (ending.ending === "answered") same((ending.answer as { host: string }).host, c.a.nodeId, "from the host the call was pinned to");
		}),
	},
];
