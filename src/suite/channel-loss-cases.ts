/**
 * honest-call-ending, when the channel to the host is lost (zorg's target, RT7 and EM12; zorg's E6, AGP's
 * first consumer-handoff case): a report of delivered or unknown ends nothing, a report of failed ends the
 * call not delivered, and an answer counts only when it arrives before the bound.
 */
import { check, same, settle, until, watch } from "./suite-check.js";
import { checkAtBound, checkNotDelivered, discardedCount, inCase, runOutBound, untilEndedPumping } from "./suite-support.js";
import type { SuiteCase } from "./suite-types.js";

export const channelLossCases: readonly SuiteCase[] = [
	{
		name: "a handler that runs before its return channel is lost, before any report, ends unknown at the bound with AGP's report of unknown",
		run: (h) => inCase(h, { holdDeliveryReports: true }, async (c) => {
			const call = watch(c.call({ operation: "hold", bound: 1000 }));
			await until(() => c.a.holds.length === 1, "the handler runs");
			c.hooks.loseChannel(c.a.nodeId);
			await until(() => c.hooks.reports().includes("unknown"), "AGP's report of unknown");
			await settle();
			check(!call.settled(), "a report of unknown ends nothing");
			await runOutBound(c, call, 1000, { waits: "the call waits until its bound", ending: "the ending at the bound" });
			checkAtBound(call.value(), "unknown", "a handler that ran before the channel was lost");
			const ending = call.value();
			c.a.holds[0]?.release();
			await settle();
			same(call.count(), 1, "one ending");
			same(call.value(), ending, "the ending unchanged");
		}),
	},
	{
		name: "a channel lost after a report of delivered ends unknown at the bound, and the report stands",
		run: (h) => inCase(h, {}, async (c) => {
			const call = watch(c.call({ operation: "hold", bound: 1000 }));
			await until(() => c.a.holds.length === 1, "the handler runs");
			for (let i = 0; i < 4000 && !c.hooks.reports().includes("delivered"); i++) {
				c.hooks.advanceAgpClock(0);
				await settle(1);
			}
			check(c.hooks.reports().includes("delivered"), "AGP reports the request delivered");
			await settle();
			check(!call.settled(), "a report of delivered ends nothing");
			c.hooks.loseChannel(c.a.nodeId);
			await settle();
			check(!call.settled(), "losing the channel after delivery ends nothing");
			await runOutBound(c, call, 1000, { ending: "the ending at the bound" });
			checkAtBound(call.value(), "delivered", "a channel lost after a report of delivered");
		}),
	},
	{
		name: "a report of failed ends the call not delivered at once, and a channel lost after it changes nothing",
		run: (h) => inCase(h, {}, async (c) => {
			const release = c.hooks.holdExecutor(c.a.nodeId);
			const closing = c.a.host.close();
			await settle();
			const call = watch(c.call({ operation: "which", bound: 1000 }));
			await settle();
			await release();
			await closing;
			const ending = await untilEndedPumping(c, call, "a request the destination refused");
			checkNotDelivered(ending, ["NO_ROUTE"], false, "AGP's report of failed");
			check(c.hooks.reports().includes("failed"), "AGP reported the request failed, after admitting it");
			same(c.a.runs.length, 0, "no handler ran");
			c.hooks.loseChannel(c.a.nodeId);
			c.hooks.advanceCallClock(1000);
			await settle();
			same(call.count(), 1, "one ending");
			same(call.value(), ending, "the ending unchanged");
		}),
	},
	{
		name: "an answer held until the caller's node has reconnected, and released before the bound, ends the call answered",
		run: (h) => inCase(h, { holdDeliveryReports: true }, async (c) => {
			const call = watch(c.call({ operation: "hold", bound: 100000 }));
			await until(() => c.a.holds.length === 1, "the handler runs");
			c.hooks.loseChannel(c.a.nodeId);
			await until(() => !c.hooks.routeVisible(c.a.nodeId, "fixture/hold"), "the route withdrawn with the channel");
			await c.hooks.ready(c.a.nodeId, "fixture/hold");
			check(!call.settled(), "the call still waits after the reconnection");
			c.a.holds[0]?.release();
			await until(call.settled, "the answer");
			const ending = call.value();
			same(ending?.ending, "answered", "the answer arriving before the bound");
			if (ending?.ending === "answered") same((ending.answer as { attempt: string }).attempt, ending.attempt, "the answer to this attempt");
		}),
	},
	{
		name: "an answer released after the bound is discarded, and the ending stays unknown",
		run: (h) => inCase(h, { holdDeliveryReports: true }, async (c) => {
			const call = watch(c.call({ operation: "hold", bound: 100000 }));
			await until(() => c.a.holds.length === 1, "the handler runs");
			c.hooks.loseChannel(c.a.nodeId);
			await until(() => c.hooks.reports().includes("unknown"), "AGP's report of unknown");
			await c.hooks.ready(c.a.nodeId, "fixture/hold");
			await runOutBound(c, call, 100000, { ending: "the ending at the bound" });
			checkAtBound(call.value(), "unknown", "the bound, before the answer");
			const ending = call.value();
			const before = discardedCount(c);
			c.a.holds[0]?.release();
			if (before !== undefined) await until(() => (discardedCount(c) ?? 0) > before, "the late answer arrives and is discarded");
			await settle();
			same(call.count(), 1, "one ending");
			same(call.value(), ending, "the late answer changes nothing");
		}),
	},
];
