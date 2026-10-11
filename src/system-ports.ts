/**
 * The ports a caller reads time and randomness through, and their defaults.
 *
 * The call's bound runs on operation-call's own clock port, apart from AGP's (zorg's target, EM12): a
 * reading in milliseconds that a change to the wall clock does not move, and a way to be called back
 * after a delay. An invocation identity takes the wall-clock time and randomness from an identity source
 * (EM11). The defaults use only what every runtime offers - `performance.now()`, `setTimeout`,
 * `Date.now()` and `crypto.getRandomValues` - so this file imports nothing particular to one runtime
 * (zorg's D31), and it is the only file of the package that reads a clock or randomness itself.
 */
import type { IdentitySource } from "./names.js";

/** A pending callback of a clock port, which can be cancelled. */
export interface ClockTimer {
	cancel(): void;
}

/** The clock a call's bound runs on. */
export interface CallClock {
	/** Milliseconds that a change to the wall clock does not move. */
	now(): number;
	/** Calls `callback` once `delayMs` milliseconds have passed on this clock. */
	schedule(delayMs: number, callback: () => void): ClockTimer;
}

/** The default call clock: `performance.now()` and `setTimeout`. */
export const systemCallClock: CallClock = Object.freeze({
	now: (): number => globalThis.performance.now(),
	schedule(delayMs: number, callback: () => void): ClockTimer {
		const handle = globalThis.setTimeout(callback, delayMs);
		return Object.freeze({ cancel: () => globalThis.clearTimeout(handle) });
	},
});

/** The default identity source: `Date.now()` and `crypto.getRandomValues`. */
export const systemIdentitySource: IdentitySource = Object.freeze({
	wallTimeMs: (): number => Date.now(),
	randomHex(digits: number): string {
		const bytes = new Uint8Array(Math.ceil(digits / 2));
		globalThis.crypto.getRandomValues(bytes);
		return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("").slice(0, digits);
	},
});
