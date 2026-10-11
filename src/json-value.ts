/**
 * JSON values as operation-call carries them, and the measures zorg's target applies to them: whether a
 * value is JSON at all, its nesting depth (EM10, EM11), whether it holds an integer AGP cannot carry, its
 * canonical JSON and size in UTF-8 bytes (shape-check's SD4; EM10's description size), and the size of a
 * message as JSON text (EM11).
 *
 * Every walk over a value keeps its own stack rather than recursing, so a value of any depth a caller can
 * build - an input of thousands of levels included - is walked to the end and meets the checks in their
 * declared order, instead of overflowing the runtime's call stack. Nothing here is particular to one
 * runtime (zorg's D31).
 */

/** Any JSON value, as parsed from JSON text. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [name: string]: JsonValue };

/** A JSON object. */
export type JsonObject = { [name: string]: JsonValue };

/** A JSON value as a caller may hold it: its arrays and objects may be read-only, as frozen constants are. */
export type JsonInput = null | boolean | number | string | readonly JsonInput[] | { readonly [name: string]: JsonInput };

/** The largest distance from zero of an integer AGP carries (AGP's maxSafeIntegerMagnitude). */
export const SAFE_INTEGER_LIMIT = 9007199254740991;

/** True for a JSON object, false for null, arrays and scalars. */
export function isJsonObject(value: unknown): value is JsonObject {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Compares two strings by Unicode code point, not by UTF-16 code unit; a prefix sorts first. */
export function compareCodePoints(a: string, b: string): number {
	const x = a[Symbol.iterator]();
	const y = b[Symbol.iterator]();
	for (;;) {
		const p = x.next();
		const q = y.next();
		if (p.done) return q.done ? 0 : -1;
		if (q.done) return 1;
		const d = (p.value.codePointAt(0) ?? 0) - (q.value.codePointAt(0) ?? 0);
		if (d !== 0) return d;
	}
}

/**
 * True when a value is JSON: null, a boolean, a finite number, a string, or arrays and plain objects of
 * them, with no array holes. A value holding itself is not JSON. Depth alone never makes it false.
 */
export function isJson(value: unknown): value is JsonValue {
	// Each entry is a value to judge, or the exit marker of a container whose members have all been pushed.
	const stack: { value: unknown; exit: boolean }[] = [{ value, exit: false }];
	const open = new Set<object>();
	while (stack.length > 0) {
		const { value: item, exit } = stack.pop() as { value: unknown; exit: boolean };
		if (exit) {
			open.delete(item as object);
			continue;
		}
		if (item === null || typeof item === "boolean" || typeof item === "string") continue;
		if (typeof item === "number") {
			if (!Number.isFinite(item)) return false;
			continue;
		}
		if (typeof item !== "object") return false;
		if (open.has(item)) return false;
		let members: unknown[];
		if (Array.isArray(item)) {
			members = [];
			for (let i = 0; i < item.length; i++) {
				if (!(i in item)) return false;
				members.push(item[i]);
			}
		} else {
			const proto = Object.getPrototypeOf(item);
			if (proto !== Object.prototype && proto !== null) return false;
			members = Object.values(item);
		}
		open.add(item);
		stack.push({ value: item, exit: true });
		for (let i = members.length - 1; i >= 0; i--) stack.push({ value: members[i], exit: false });
	}
	return true;
}

/** Levels of nesting: 0 for a scalar, and one more than its deepest member for an array or object (EM10). */
export function nestingDepth(value: JsonInput): number {
	let deepest = 0;
	// Each entry is a value and the level it is at if it is an array or object, the value itself at 1.
	const stack: { value: JsonInput; level: number }[] = [{ value, level: 1 }];
	while (stack.length > 0) {
		const { value: item, level } = stack.pop() as { value: JsonInput; level: number };
		if (item === null || typeof item !== "object") continue;
		if (level > deepest) deepest = level;
		for (const member of Object.values(item)) stack.push({ value: member as JsonInput, level: level + 1 });
	}
	return deepest;
}

/** Escapes one JSON pointer token (RFC 6901). */
function pointerToken(token: string): string {
	return token.replaceAll("~", "~0").replaceAll("/", "~1");
}

/**
 * The pointer of the first integer more than 9007199254740991 from zero, in shape-check's SD5 order - array
 * indices as numbers, names by code point, a pointer before its descendants - or undefined when none.
 */
export function firstUnsafeInteger(value: JsonInput): string | undefined {
	interface Place { value: JsonInput; parent: Place | undefined; token: string }
	const stack: Place[] = [{ value, parent: undefined, token: "" }];
	while (stack.length > 0) {
		const place = stack.pop() as Place;
		const item = place.value;
		if (typeof item === "number") {
			if (!Number.isInteger(item) || Math.abs(item) <= SAFE_INTEGER_LIMIT) continue;
			const tokens: string[] = [];
			for (let p: Place | undefined = place; p?.parent !== undefined; p = p.parent) tokens.push(p.token);
			return tokens.reverse().map((token) => `/${token}`).join("");
		}
		if (Array.isArray(item)) {
			for (let i = item.length - 1; i >= 0; i--) stack.push({ value: item[i] as JsonInput, parent: place, token: String(i) });
		} else if (item !== null && typeof item === "object") {
			const record = item as { readonly [name: string]: JsonInput };
			const names = Object.keys(record).sort(compareCodePoints);
			for (let i = names.length - 1; i >= 0; i--) {
				const name = names[i] as string;
				stack.push({ value: record[name] as JsonInput, parent: place, token: pointerToken(name) });
			}
		}
	}
	return undefined;
}

/**
 * Writes a value as JSON text, in canonical order when asked (SD4: no whitespace, properties by code
 * point, strings and numbers as JSON.stringify writes them), otherwise in the value's own property order,
 * as JSON.stringify writes it.
 */
export function writeJson(value: JsonInput, canonical: boolean): string {
	const out: string[] = [];
	// Each entry is text to write as it stands, or a value to write; entries are popped in writing order.
	const stack: ({ text: string } | { value: JsonInput })[] = [{ value }];
	while (stack.length > 0) {
		const entry = stack.pop() as { text: string } | { value: JsonInput };
		if ("text" in entry) {
			out.push(entry.text);
			continue;
		}
		const item = entry.value;
		if (Array.isArray(item)) {
			out.push("[");
			stack.push({ text: "]" });
			for (let i = item.length - 1; i >= 0; i--) {
				stack.push({ value: item[i] as JsonInput });
				if (i > 0) stack.push({ text: "," });
			}
		} else if (item !== null && typeof item === "object") {
			const record = item as { readonly [name: string]: JsonInput };
			const names = canonical ? Object.keys(record).sort(compareCodePoints) : Object.keys(record);
			out.push("{");
			stack.push({ text: "}" });
			for (let i = names.length - 1; i >= 0; i--) {
				const name = names[i] as string;
				stack.push({ value: record[name] as JsonInput });
				stack.push({ text: `${i > 0 ? "," : ""}${JSON.stringify(name)}:` });
			}
		} else out.push(JSON.stringify(item));
	}
	return out.join("");
}

/** Canonical JSON of a value (shape-check's SD4). */
export function canonicalJson(value: JsonInput): string {
	return writeJson(value, true);
}

/** The size in UTF-8 bytes of a string, a lone surrogate counted as the three bytes of U+FFFD. */
export function utf8ByteLength(text: string): number {
	let n = 0;
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		if (c < 0x80) n += 1;
		else if (c < 0x800) n += 2;
		else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) {
			n += 4;
			i++;
		} else n += 3;
	}
	return n;
}

/** A deep copy of a JSON value, so nothing a caller holds afterwards can change what was declared. */
export function copyJson(value: JsonInput): JsonValue {
	return JSON.parse(writeJson(value, false)) as JsonValue;
}

/** The first 128 code points of a string, and whether it was cut (EM9). */
export function cutTo128(text: string): { text: string; truncated: boolean } {
	const points = Array.from(text);
	return points.length > 128 ? { text: points.slice(0, 128).join(""), truncated: true } : { text, truncated: false };
}
