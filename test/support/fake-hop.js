// fake-hop - operation-call's own caller behind an in-process stand-in for a hop, so the caller suite's hop
// allowance (zorg's D45; operation-proxy's PX5, PX6, PX10) runs in operation-call's tests, not only in
// operation-proxy's.
//
// The stand-in keeps the caller's bound, from the moment it is invoked, and makes the call on the far side
// with a bound that ends the allowance sooner - the harness's allowance, or half the bound if that is less,
// rounded down, the far side's bound rounded down to a whole millisecond (PX5; zorg's D46) - both on the
// fixture's call bound clock; less than 1 ms left for the far side ends it not delivered with the proxy's
// `deadline-passed`, as PX5 says. An invalid call is handed on unchanged, so the call layer throws for it.
// The far side's ending crosses the hop a turn of the event loop later, and is read there on the stand-in's
// own clock port - the caller suite's fault hook's, the call layer's beneath it being the fixture's plain call
// clock; when the caller's own bound has passed first, by its timer or as the ending is read, the call ends
// `unknown` with `hop-stalled` and no AGP code or delivery report, as operation-proxy's client half ends it.
// A reading that throws shows nothing passed, so the ending read decides, and the timer's cancellation comes
// after the ending is settled, so its failure changes nothing (zorg's EM12). A hop that is `held` carries no
// ending at all, so every call that ends at its bound ends `hop-stalled`: the case the suite must refuse.
// A call accepting parts (zorg's D64; operation-proxy's PX4, PX5 as Delta 4's stage 6 has them): the stand-in's
// own deadline is a bound on signs of life, moved a bound on by each part it hands to the caller's `onPart` and
// by each `alive` it writes the caller - one whenever half the far side's bound passes while the far call is in
// flight - so it ends `hop-stalled` only when the far side has gone quiet for a whole bound.
import { openTopology } from "./fixture.js";

/** True for a bound EM12 allows; any other is handed on as read, for the call layer to throw as it does. */
const validBound = (bound) => Number.isInteger(bound) && bound >= 1 && bound <= 2147483647;

/** The hop's caller, in front of operation-call's own. */
function hopCaller(inner, clock, allowanceMs, held) {
	return {
		discarded: () => inner.discarded(),
		invoke(call) {
			// The client half's bound starts as it is invoked; the far side's ends the allowance sooner (PX5).
			const start = clock.now();
			if (call === null || typeof call !== "object") return inner.invoke(call);
			// Each field of the request is read once, as a client half reads it (EM12), and what is given is passed on.
			const read = {};
			for (const name of ["host", "service", "operation", "input", "bound", "invocation", "repeat", "signal", "onPart"]) {
				const value = call[name];
				if (value !== undefined) read[name] = value;
			}
			if (!validBound(read.bound)) return inner.invoke(read);
			const allowance = Math.min(allowanceMs, Math.floor(read.bound / 2));
			const invocation = read.invocation === undefined ? inner.newInvocation() : read.invocation;
			const farBound = Math.floor(start + read.bound - allowance - clock.now());
			if (farBound < 1) {
				return Promise.resolve(Object.freeze({ ending: "not-delivered", invocation, attempt: null, operation: read.operation, agpCode: null, proxyCode: "deadline-passed", earlierAttemptsUncertain: read.repeat === true }));
			}
			const parts = typeof read.onPart === "function";
			let deadline = start + read.bound;
			let farEnded = false;
			/** A sign of life the stand-in hands across moves its deadline a bound on. */
			const lived = () => {
				try {
					deadline = clock.now() + read.bound;
				} catch {
					// A reading that throws moves nothing.
				}
			};
			const onPart = parts ? (part) => { lived(); return read.onPart(part); } : undefined;
			const far = inner.invoke({ ...read, invocation, bound: farBound, ...(parts ? { onPart } : {}) });
			return new Promise((resolve, reject) => {
				let ended = false;
				let attempt = null;
				let timer;
				let aliveTimer;
				const cancel = () => {
					for (const pending of [aliveTimer, timer]) {
						try {
							pending?.cancel();
						} catch {
							// A timer that still runs finds the call ended.
						}
					}
				};
				const end = (ending) => {
					if (ended) return;
					ended = true;
					resolve(ending);
					cancel();
				};
				const stalled = () => Object.freeze({
					ending: "unknown", invocation, attempt, operation: read.operation, reason: "hop-stalled", agpCode: null, deliveryReport: null,
				});
				const wake = () => {
					if (ended) return;
					let remaining;
					try {
						remaining = deadline - clock.now();
					} catch {
						remaining = 0;
					}
					if (remaining <= 0) return end(stalled());
					timer = clock.schedule(Math.ceil(remaining), wake);
				};
				timer = clock.schedule(Math.max(0, deadline - clock.now()), wake);
				if (parts) {
					const every = Math.max(1, Math.floor(farBound / 2));
					const beat = () => {
						if (ended || farEnded) return;
						lived();
						aliveTimer = clock.schedule(every, beat);
					};
					aliveTimer = clock.schedule(every, beat);
				}
				far.then((ending) => {
					farEnded = true;
					attempt = ending.attempt;
					if (held) return;
					setImmediate(() => {
						if (ended) return;
						let passed;
						try {
							passed = clock.now() >= deadline;
						} catch {
							passed = false;
						}
						end(passed ? stalled() : ending);
					});
				}, (error) => {
					ended = true;
					cancel();
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
			const t = await openTopology({ ...options, boundedInvoke: false, faultCaller: false });
			return { caller: hopCaller(t.caller, t.faultableClock, allowanceMs, held), callerNodeId: "caller", hosts: t.hosts, hooks: t.hooks, close: () => t.close() };
		},
	};
}
