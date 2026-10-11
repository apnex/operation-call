// fake-hop - operation-call's own caller behind an in-process stand-in for a hop, so the caller suite's hop
// allowance (zorg's D45; operation-proxy's PX5, PX6, PX10) runs in operation-call's tests, not only in
// operation-proxy's.
//
// The stand-in keeps the caller's bound and makes the call on the far side with a bound that ends the
// allowance sooner - the harness's allowance, or half the bound if that is less, rounded down - both on the
// fixture's call bound clock. The far side's ending crosses the hop a turn of the event loop later; when the
// caller's own bound passes first, the call ends `unknown` with `hop-stalled` and no AGP code or delivery
// report, as operation-proxy's client half ends it. A hop that is `held` carries no ending at all, so every
// call that ends at its bound ends `hop-stalled`: the case the suite must refuse.
import { openTopology } from "./fixture.js";

/** The hop's caller, in front of operation-call's own. */
function hopCaller(inner, clock, allowanceMs, held) {
	return {
		discarded: () => inner.discarded(),
		invoke(call) {
			const allowance = Math.min(allowanceMs, Math.floor(call.bound / 2));
			const invocation = call.invocation ?? inner.newInvocation();
			const far = inner.invoke({ ...call, invocation, bound: call.bound - allowance });
			return new Promise((resolve, reject) => {
				let ended = false;
				let attempt = null;
				const end = (ending) => {
					if (ended) return;
					ended = true;
					timer.cancel();
					resolve(ending);
				};
				const timer = clock.schedule(call.bound, () => end(Object.freeze({
					ending: "unknown", invocation, attempt, operation: call.operation, reason: "hop-stalled", agpCode: null, deliveryReport: null,
				})));
				far.then((ending) => {
					attempt = ending.attempt;
					if (!held) setImmediate(() => end(ending));
				}, (error) => {
					timer.cancel();
					reject(error);
				});
			});
		},
	};
}

/** A caller suite harness for operation-call's caller behind the stand-in hop, stating its allowance. */
export function fakeHopHarness({ allowanceMs, held = false }) {
	return {
		hopAllowanceMs: allowanceMs,
		async open(options = {}) {
			const t = await openTopology({ ...options, boundedInvoke: false });
			return { caller: hopCaller(t.caller, t.callClock, allowanceMs, held), callerNodeId: "caller", hosts: t.hosts, hooks: t.hooks, close: () => t.close() };
		},
	};
}
