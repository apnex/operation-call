/**
 * Declaring operations as data, and the description a host gives of what it serves (zorg's target, EM10).
 *
 * A declaration names the operation, its input shape - a shape document in shape-check's dialect - and
 * whether it answers whole or in parts. A host refuses to serve under a name, or to declare an operation
 * named, other than as EM1's pattern allows (`invalid-name`); it refuses an input shape that nests more
 * than 20 levels (`shape-too-deep`), that shape-check refuses (`shape-refused`), or that holds an integer
 * more than 9007199254740991 from zero (`unsafe-shape`), and a declaration that would make the canonical
 * JSON of its whole description answer exceed 524288 bytes (`description-too-large`), checked in that
 * order. Depth is measured before shape-check prepares the shape, so shape-check never meets one deeper
 * than 20 levels. A refused declaration exposes no endpoint and leaves the operations already declared as
 * they were. A shape that is not a JSON value is a programming error, thrown before any shape is judged.
 */
import {
	firstUnsafeInteger,
	nestingDepth,
	prepareShapeDocument,
	SHAPE_DIALECT_ID,
	snapshotJson,
	toCanonicalJson,
	utf8ByteLength,
	type JsonInput,
	type JsonValue,
	type PreparedShape,
} from "@apnex/shape-check";
import { DESCRIBE_OPERATION, isName } from "./names.js";

/** The limits a declaration keeps to (EM10). */
export const DECLARATION_LIMITS = Object.freeze({
	/** Levels an input shape may nest. */
	shapeDepth: 20,
	/** Bytes of canonical JSON the whole description answer may take. */
	descriptionBytes: 524288,
});

/** How an operation answers: whole, or in ordered parts (D9). */
export type AnswerMode = "whole" | "parts";

/** An operation declared as data. */
export interface OperationDeclaration {
	readonly name: string;
	readonly input: JsonInput;
	readonly answers: AnswerMode;
}

/** One operation as a description lists it. */
export interface DescribedOperation {
	readonly name: string;
	readonly input: JsonValue;
	readonly answers: AnswerMode;
}

/** What a host serves under its name (EM10): every declared operation, ordered by name; `describe` is not listed. */
export interface Description {
	readonly service: string;
	readonly operations: readonly DescribedOperation[];
}

/** Why a host refused to open or to declare (EM10). */
export type HostRefusalCode = "invalid-name" | "shape-too-deep" | "shape-refused" | "unsafe-shape" | "description-too-large";

/** A host's refusal to open or to declare, `{code, message, details}`, as a store's refusal to open is (EM10). */
export interface HostRefusal {
	readonly code: HostRefusalCode;
	readonly message: string;
	readonly details: { readonly [name: string]: JsonValue };
}

/** The input shape of `describe`: an empty object. */
export const DESCRIBE_INPUT: JsonValue = Object.freeze({ $schema: SHAPE_DIALECT_ID, type: "object", additionalProperties: false }) as JsonValue;

/** The first 128 code points of a string, and whether it was cut (EM9). */
function cutTo128(text: string): { text: string; truncated: boolean } {
	const points = Array.from(text);
	return points.length > 128 ? { text: points.slice(0, 128).join(""), truncated: true } : { text, truncated: false };
}

/** Compares two strings by Unicode code point, not by UTF-16 code unit; a prefix sorts first. */
function compareCodePoints(a: string, b: string): number {
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

/** A name as a refusal's details hold it: its first 128 code points, and `truncated` when it was cut (EM9). */
export function nameDetails(name: string): { [name: string]: JsonValue } {
	const cut = cutTo128(name);
	return cut.truncated ? { name: cut.text, truncated: true } : { name: cut.text };
}

/** Builds a host's refusal. */
export function hostRefusal(code: HostRefusalCode, message: string, details: { [name: string]: JsonValue }): HostRefusal {
	return Object.freeze({ code, message, details: Object.freeze(details) });
}

/** Throws when a declaration is not data of the declared form: a programming error, not a refusal. */
export function checkDeclarationForm(declaration: OperationDeclaration): void {
	if (declaration === null || typeof declaration !== "object") throw new TypeError("a declaration is { name, input, answers }");
	if (typeof declaration.name !== "string") throw new TypeError("a declaration's name is a string");
	if (declaration.answers !== "whole" && declaration.answers !== "parts") throw new TypeError("a declaration's answers is \"whole\" or \"parts\"");
	if (!snapshotJson(declaration.input).ok) throw new TypeError(`the input shape of operation ${JSON.stringify(cutTo128(declaration.name).text)} is not a JSON value`);
}

/** The description of a set of declared operations, ordered by name in code-point order. */
export function describe(service: string, operations: Iterable<DescribedOperation>): Description {
	const listed = [...operations].sort((a, b) => compareCodePoints(a.name, b.name));
	return { service, operations: listed.map((o) => ({ name: o.name, input: o.input, answers: o.answers })) };
}

/** The size of a description answer in canonical JSON. */
export function descriptionBytes(description: Description): number {
	return utf8ByteLength(toCanonicalJson(description as unknown as JsonValue));
}

/**
 * Judges a declaration against the operations already declared, in EM10's order, returning the prepared
 * shape and the copy described, or the refusal. `served` names every operation the host already serves.
 */
export function judgeDeclaration(service: string, declaration: OperationDeclaration, declared: readonly DescribedOperation[], served: ReadonlySet<string>):
	{ readonly accepted: true; readonly described: DescribedOperation; readonly prepared: PreparedShape & { accepted: true } }
	| { readonly accepted: false; readonly refusal: HostRefusal } {
	const name = declaration.name;
	if (!isName(name)) return { accepted: false, refusal: hostRefusal("invalid-name", "An operation's name must match ^[a-z0-9][a-z0-9-]{0,62}$.", nameDetails(name)) };
	if (name === DESCRIBE_OPERATION || served.has(name)) {
		return { accepted: false, refusal: hostRefusal("invalid-name", `The host already serves an operation named ${name}; a name is declared once, and describe is the host's own.`, nameDetails(name)) };
	}
	const snap = snapshotJson(declaration.input);
	if (!snap.ok) throw new TypeError(`the input shape of operation ${JSON.stringify(cutTo128(name).text)} is not a JSON value`);
	const input = snap.value;
	const depth = nestingDepth(input);
	if (depth > DECLARATION_LIMITS.shapeDepth) {
		return { accepted: false, refusal: hostRefusal("shape-too-deep", "An operation's input shape nests more than 20 levels.", { name, depth, limit: DECLARATION_LIMITS.shapeDepth }) };
	}
	const prepared = prepareShapeDocument(input);
	if (!prepared.accepted) {
		return { accepted: false, refusal: hostRefusal("shape-refused", "shape-check refused the operation's input shape.", { name, problems: prepared.problems as unknown as JsonValue }) };
	}
	const unsafe = firstUnsafeInteger(input);
	if (unsafe !== null) {
		return { accepted: false, refusal: hostRefusal("unsafe-shape", "An operation's input shape holds an integer more than 9007199254740991 from zero.", { name, pointer: unsafe.pointer }) };
	}
	const described: DescribedOperation = { name, input, answers: declaration.answers };
	const bytes = descriptionBytes(describe(service, [...declared, described]));
	if (bytes > DECLARATION_LIMITS.descriptionBytes) {
		return { accepted: false, refusal: hostRefusal("description-too-large", "The declaration would make the host's description exceed 524288 bytes in canonical JSON.", { name, bytes, limit: DECLARATION_LIMITS.descriptionBytes }) };
	}
	return { accepted: true, described, prepared };
}
