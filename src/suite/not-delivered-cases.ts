/**
 * not-delivered-signal (zorg's target, EM12; operation-call's D2; zorg's E6, AGP's second, fourth and fifth
 * consumer-handoff cases): "not delivered" only when AGP refused the attempt outright, so it had no effect,
 * and it proves nothing about an earlier attempt of the same invocation.
 */
import type { CallEnding } from "../call-types.js";
import { check, same, settle, until, watch } from "./suite-check.js";
import { beneathBound, checkAtBound, checkNotDelivered, inCase, runOutBound, untilEndedPumping } from "./suite-support.js";
import type { SuiteCase } from "./suite-types.js";

export const notDeliveredCases: readonly SuiteCase[] = [
	{
		name: "a send whose admission deadline expires while queued is not delivered, with TIMEOUT, and after the queue is released and drained it has not arrived",
		run: (h) => inCase(h, {}, async (c) => {
			const admission = beneathBound(c.harness, 50);
			const release = c.hooks.holdExecutor(c.session.callerNodeId);
			const call = watch(c.call({ operation: "which", bound: 50 }));
			await settle();
			c.hooks.advanceAgpClock(admission - 1);
			await settle();
			check(!call.settled(), "the admission deadline, the time the call beneath is given, has not yet passed");
			c.hooks.advanceAgpClock(1);
			await until(call.settled, "AGP's refusal");
			checkNotDelivered(call.value(), ["TIMEOUT"], false, "an admission deadline passed while queued");
			await release();
			c.hooks.advanceAgpClock(0);
			await settle();
			same(c.a.runs.length + c.b.runs.length, 0, "the request never arrived");
		}),
	},
	{
		name: "a send cancelled while queued is not delivered, with ABORTED, and after the queue is released and drained it has not arrived",
		run: (h) => inCase(h, {}, async (c) => {
			const release = c.hooks.holdExecutor(c.session.callerNodeId);
			const controller = new AbortController();
			const call = watch(c.call({ operation: "which", bound: 1000, signal: controller.signal }));
			await settle();
			controller.abort();
			await until(call.settled, "AGP's refusal");
			checkNotDelivered(call.value(), ["ABORTED"], false, "a send cancelled while queued");
			await release();
			c.hooks.advanceAgpClock(0);
			await settle();
			same(c.a.runs.length + c.b.runs.length, 0, "the request never arrived");
		}),
	},
	{
		name: "a route observed reachable and then withdrawn before the send ends not delivered, from AGP's refusal, and no other advertiser handles it",
		run: (h) => inCase(h, {}, async (c) => {
			check(c.hooks.routeVisible(c.a.nodeId, "fixture/which"), "the route is observed reachable");
			await c.a.host.close();
			await until(() => !c.hooks.routeVisible(c.a.nodeId, "fixture/which"), "the route withdrawn");
			const ending = await untilEndedPumping(c, watch(c.call({ operation: "which" })), "a send after the withdrawal");
			checkNotDelivered(ending, ["NO_ROUTE", "INSTANCE_UNREACHABLE"], false, "a stale observation of reachability");
			same(c.a.runs.length + c.b.runs.length, 0, "no host handled it");
		}),
	},
	{
		name: "an attempt that ends unknown followed by one refused outright leaves the invocation's uncertainty standing",
		run: (h) => inCase(h, {}, async (c) => {
			const first = watch(c.call({ operation: "silent", bound: 100 }));
			await until(() => c.a.runs.length === 1, "the first attempt runs");
			const one = await runOutBound(c, first, 100, { ending: "the first attempt's ending" }) as CallEnding;
			checkAtBound(one, null, "the first attempt");
			await c.a.host.close();
			await until(() => !c.hooks.routeVisible(c.a.nodeId, "fixture/silent"), "the route withdrawn");
			const two = await untilEndedPumping(c, watch(c.call({ operation: "silent", invocation: one.invocation, repeat: true })), "the repeated attempt");
			checkNotDelivered(two, ["NO_ROUTE", "INSTANCE_UNREACHABLE"], true, "a repeat refused outright");
			same(two.invocation, one.invocation, "the same invocation");
			check(two.attempt !== one.attempt, "a new attempt");
		}),
	},
	{
		name: "an invocation named but not marked a repeat, refused outright, says no earlier attempt is uncertain",
		run: (h) => inCase(h, {}, async (c) => {
			const invocation = (await c.ended({ operation: "which" })).invocation;
			checkNotDelivered(await c.ended({ operation: "not-declared", invocation }), ["NO_ROUTE"], false, "a named invocation that is no repeat");
			checkNotDelivered(await c.ended({ operation: "not-declared", invocation, repeat: true }), ["NO_ROUTE"], true, "the same marked a repeat");
		}),
	},
	{
		name: "a request within 16777216 bytes but over the peer's receive limit ends not delivered with MESSAGE_TOO_LARGE, another call in flight and a small one following answered",
		run: (h) => inCase(h, {}, async (c) => {
			const inFlight = watch(c.call({ operation: "hold", bound: 10000 }));
			await until(() => c.a.holds.length === 1, "another call in flight");
			checkNotDelivered(await c.ended({ operation: "echo", input: "x".repeat(2_000_000) }), ["MESSAGE_TOO_LARGE"], false, "a request over the peer's limit");
			c.a.holds[0]?.release();
			await until(inFlight.settled, "the call in flight");
			same(inFlight.value()?.ending, "answered", "the call in flight is answered");
			same((await c.ended({ operation: "echo", input: "small" })).ending, "answered", "a small call following is answered");
		}),
	},
];
