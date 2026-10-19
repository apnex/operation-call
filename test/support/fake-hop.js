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
// by each `alive` it writes the caller - one whenever half the far side's bound passes, while the far call is in
// flight, since it last handed across a part or an `alive`, read a turn of the event loop after it is written,
// as one crossing a channel is - so it ends
// `hop-stalled` only when the far side has gone quiet for a whole bound; a part or an `alive` read at or after
// that deadline is not taken. From an abort, a sign of life moves the deadline to the bound after the abort and
// no further (Delta 4's amendment 4), so an `alive` written before the abort and read after it still counts.
// The far call is given the stand-in's own abort signal, which the caller's abort fires, as a relayed `abort`
// does, and which fires too when the stand-in ends a call accepting parts `hop-stalled`, so the far call is
// cancelled rather than left running (operation-proxy's PX5).
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
			let abortedAt;
			if (parts && read.signal !== undefined) {
				const noteAbort = () => {
					try {
						abortedAt ??= clock.now();
					} catch {
						abortedAt ??= start;
					}
				};
				if (read.signal.aborted === true) abortedAt = start;
				else read.signal.addEventListener?.("abort", noteAbort, { once: true });
			}
			/** True once the stand-in's deadline has passed on its clock; a reading that throws shows nothing passed. */
			const passed = () => {
				try {
					return clock.now() >= deadline;
				} catch {
					return false;
				}
			};
			/** A sign of life read before the deadline moves it a bound on, or to the bound after an abort, no further. */
			const lived = () => {
				try {
					const moved = clock.now() + read.bound;
					deadline = abortedAt === undefined ? moved : Math.min(moved, abortedAt + read.bound);
				} catch {
					// A reading that throws moves nothing.
				}
			};
			// The far call's abort signal, which the caller's fires and a stalled call in parts fires too (PX5). A
			// signal that is not an AbortSignal is handed on as read, for the call layer to throw as it does.
			const far = new AbortController();
			const genuine = read.signal instanceof AbortSignal;
			const ownSignal = genuine || (parts && read.signal === undefined);
			if (genuine) {
				if (read.signal.aborted) far.abort(read.signal.reason);
				else read.signal.addEventListener("abort", () => far.abort(read.signal.reason), { once: true });
			}
			let settle = () => undefined;
			/** When the stand-in last handed across a part or an `alive`, from which its next `alive` falls due (PX5). */
			let lastWritten = clock.now();
			const onPart = parts ? (part) => {
				if (settle()) return undefined;
				try {
					lastWritten = clock.now();
				} catch {
					// The next alive counts on from the last time known.
				}
				lived();
				return read.onPart(part);
			} : undefined;
			const farCall = inner.invoke({ ...read, invocation, bound: farBound, ...(ownSignal ? { signal: far.signal } : {}), ...(parts ? { onPart } : {}) });
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
				const stalled = () => {
					// A call in parts ended without its far ending: the far call is cancelled (PX5).
					if (parts && !farEnded) far.abort(new Error("the hop stalled"));
					return Object.freeze({ ending: "unknown", invocation, attempt, operation: read.operation, reason: "hop-stalled", agpCode: null, deliveryReport: null });
				};
				/** True when the call has ended, or its deadline passed as a sign of life is read, which ends it. */
				settle = () => {
					if (ended) return true;
					if (!passed()) return false;
					end(stalled());
					return true;
				};
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
						let now;
						try {
							now = clock.now();
						} catch {
							now = lastWritten + every;
						}
						const remaining = lastWritten + every - now;
						if (remaining <= 0) {
							lastWritten = now;
							// Written now, read a turn later, as an `alive` crossing a channel is.
							setImmediate(() => {
								if (!settle()) lived();
							});
						}
						aliveTimer = clock.schedule(remaining <= 0 ? every : Math.ceil(remaining), beat);
					};
					aliveTimer = clock.schedule(every, beat);
				}
				farCall.then((ending) => {
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
