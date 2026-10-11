/**
 * The suite's assertions and waits, written without any runtime's test library so the suite stays free
 * of runtime-specific modules (zorg's D31). A failed check throws an Error naming what was expected.
 */
import { canonicalJson, isJson, type JsonInput } from "../json-value.js";

/** Throws unless the condition holds. */
export function check(condition: unknown, what: string): asserts condition {
	if (!condition) throw new Error(`caller suite: expected ${what}`);
}

/** Writes any value for a message, JSON where it can be. */
function show(value: unknown): string {
	try {
		return isJson(value) ? canonicalJson(value as JsonInput) : String(value);
	} catch {
		return String(value);
	}
}

/** Throws unless two values are the same JSON, compared in canonical JSON, or strictly equal otherwise. */
export function same(actual: unknown, expected: unknown, what: string): void {
	const equal = isJson(actual) && isJson(expected)
		? canonicalJson(actual as JsonInput) === canonicalJson(expected as JsonInput)
		: Object.is(actual, expected);
	if (!equal) throw new Error(`caller suite: expected ${what}: ${show(expected)}, got ${show(actual)}`);
}

/** One turn of the event loop, after every pending promise reaction. */
export function turn(): Promise<void> {
	return new Promise((resolve) => globalThis.setTimeout(resolve, 0));
}

/** Waits a number of turns, so every reaction the last step started has run. */
export async function settle(turns = 20): Promise<void> {
	for (let i = 0; i < turns; i++) await turn();
}

/** Waits until a condition holds, failing after a bounded number of turns rather than hanging. */
export async function until(condition: () => boolean, what: string, turns = 4000): Promise<void> {
	for (let i = 0; i < turns; i++) {
		if (condition()) return;
		await turn();
	}
	throw new Error(`caller suite: waited for ${what}, which never happened`);
}

/** A promise with its resolution observable: whether it has settled, and its value. */
export interface Watched<T> {
	readonly promise: Promise<T>;
	settled(): boolean;
	value(): T | undefined;
	/** How many times it has settled: a promise settles once, so anything but 0 or 1 is a defect. */
	count(): number;
}

/** Watches a promise. */
export function watch<T>(promise: Promise<T>): Watched<T> {
	let done = 0;
	let result: T | undefined;
	const watched = promise.then((v) => { done++; result = v; return v; }, (e: unknown) => { done++; throw e; });
	watched.catch(() => undefined);
	return { promise: watched, settled: () => done > 0, value: () => result, count: () => done };
}

/** A latch an operation waits on and a case releases. */
export interface Latch {
	readonly wait: Promise<void>;
	release(): void;
}

/** A new latch. */
export function latch(): Latch {
	let release!: () => void;
	const wait = new Promise<void>((resolve) => { release = resolve; });
	return { wait, release };
}
