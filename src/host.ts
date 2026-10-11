/**
 * The host half (zorg's target, EM10, EM11 and EM13): serve declared operations by name, each at its own AGP
 * endpoint `<service>/<operation>`, and give every request exactly one end message, even when the operation
 * fails.
 *
 * For each request as it arrives, the host first asks the evidence function the host supplied (in zorg,
 * caller-identity's answer). It then reads the request: one that breaks EM11's form, or names an operation
 * other than its endpoint's, is refused as `malformed-request` when its correlation label is an attempt
 * identity, and discarded otherwise. Input that does not fit the declared shape is refused as `input-misfit`
 * with shape-check's misfit records unchanged, before the operation runs. The operation answers or refuses;
 * one that throws ends `failed` with `operation-threw`. An answer that cannot cross AGP whole, or whose send
 * AGP refuses, is replaced by a `failed` end with `answer-not-sendable` and AGP's code, or null when the host
 * found it unsendable itself; when that cannot be sent either, nothing is sent. Every answer goes to the
 * request's source endpoint, pinned to its origin node, under the request's attempt identity.
 */
import type { AgpNode, EndpointBinding, EndpointName, JsonObject } from "@agp/node";
import { prepareShapeDocument, type PreparedShape } from "@apnex/shape-check";
import { checkDeclarationForm, describe, DESCRIBE_INPUT, hostRefusal, judgeDeclaration, nameDetails, type Description, type DescribedOperation, type HostRefusal, type OperationDeclaration } from "./declarations.js";
import { copyJson, isJson, type JsonInput, type JsonValue } from "./json-value.js";
import { crossesAgp, readMessage, writeEnd, type EndContent, type MessageAddress } from "./message-format.js";
import { DESCRIBE_OPERATION, invocationOfAttempt, isAttemptId, isName } from "./names.js";
import { inputMisfit, isRefusalRecord, malformedRequest, type RefusalRecord } from "./refusal.js";

/** AGP's context for a delivered request: its message, correlation, source, ingress and session. */
export type DeliveryContext = Parameters<Parameters<AgpNode["expose"]>[1]>[1]["delivery"];

/** The host's evidence port: given a request's delivery context as it arrives, the evidence of who is calling. */
export type EvidenceFunction = (delivery: DeliveryContext) => unknown;

/** What a host is opened with. */
export interface HostOptions {
	/** The name the host serves under, matching EM1's pattern; its operations are `<service>/<operation>`. */
	readonly service: string;
	/** Asked for each request as it arrives; its answer is the operation's `evidence`. Null when absent. */
	readonly evidence?: EvidenceFunction;
}

/** What an operation is given beside its input. */
export interface OperationContext {
	readonly service: string;
	readonly operation: string;
	/** The invocation identity, the same for every attempt of the invocation (`invocation-identity`). */
	readonly invocation: string;
	readonly attempt: string;
	/** AGP's delivery context for the request, as AGP gave it (`peer-identity-evidence`). */
	readonly delivery: DeliveryContext;
	/** The evidence function's answer for this request, or null when the host supplied none. */
	readonly evidence: unknown;
	/** AGP's handler signal, which aborts when the node stops. */
	readonly signal: AbortSignal;
}

/** How an operation ends an invocation: it answers, or it refuses with a refusal record (EM9). */
export type OperationResult =
	| { readonly outcome: "answered"; readonly answer: JsonInput }
	| { readonly outcome: "refused"; readonly refusal: RefusalRecord };

/** An operation: given input that fits its declared shape, it answers or refuses. */
export type OperationHandler = (input: JsonValue, context: OperationContext) => OperationResult | Promise<OperationResult>;

/** Whether a declaration took effect. */
export type DeclarationOutcome = { readonly declared: true } | { readonly declared: false; readonly refusal: HostRefusal };

/** A host serving operations under one name on one AGP node. */
export interface OperationHost {
	readonly service: string;
	/** Declares an operation and exposes its endpoint, or refuses as EM10 says, exposing nothing. */
	declare(declaration: OperationDeclaration, handler: OperationHandler): Promise<DeclarationOutcome>;
	/** The description `<service>/describe` answers. */
	description(): Description;
	/** Closes every endpoint the host exposed. */
	close(): Promise<void>;
}

/** Whether a host opened. */
export type HostOpening = { readonly opened: true; readonly host: OperationHost } | { readonly opened: false; readonly refusal: HostRefusal };

/** One operation the host serves. */
interface Served {
	readonly name: string;
	readonly prepared: PreparedShape & { accepted: true };
	readonly handler: OperationHandler;
}

/** True when a value is exactly one of the two results an operation may give. */
function isResult(value: unknown): value is OperationResult {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const v = value as { [name: string]: unknown };
	const names = Object.keys(v);
	if (v.outcome === "answered") return names.length === 2 && Object.hasOwn(v, "answer");
	if (v.outcome === "refused") return names.length === 2 && isRefusalRecord(v.refusal);
	return false;
}

/** Opens a host under a name on an AGP node, exposing `<service>/describe`, or refuses an invalid name. */
export async function createOperationHost(node: AgpNode, options: HostOptions): Promise<HostOpening> {
	if (!node || typeof node.expose !== "function" || typeof node.send !== "function") throw new TypeError("createOperationHost needs an AGP node");
	if (options === null || typeof options !== "object") throw new TypeError("createOperationHost needs { service }");
	const { service, evidence } = options;
	if (evidence !== undefined && typeof evidence !== "function") throw new TypeError("a host's evidence is a function of the delivery context");
	if (typeof service !== "string") throw new TypeError("a host's service is a string");
	if (!isName(service)) return { opened: false, refusal: hostRefusal("invalid-name", "A host serves under a name matching ^[a-z0-9][a-z0-9-]{0,62}$.", nameDetails(service)) };

	const declared: DescribedOperation[] = [];
	const bindings: EndpointBinding[] = [];
	const served = new Set<string>();
	let closed = false;
	let queue: Promise<unknown> = Promise.resolve();

	/** Sends an end message for a request; an answer that cannot be sent becomes a failed end, sent once. */
	const reply = async (address: MessageAddress, content: EndContent, to: DeliveryContext): Promise<void> => {
		const from = `${service}/${address.operation}` as EndpointName;
		const send = (message: JsonValue): Promise<unknown> => node.send(from, to.source.endpoint, message as JsonObject, {
			...(to.correlationId === undefined ? {} : { correlationId: to.correlationId }),
			destinationSelector: { originNodeId: to.source.originNodeId, mode: "pinned" },
		});
		let message = writeEnd(address, content) as unknown as JsonValue;
		if (content.outcome !== "failed" && !crossesAgp(message)) {
			message = writeEnd(address, { outcome: "failed", reason: "answer-not-sendable", agpCode: null }) as unknown as JsonValue;
			content = { outcome: "failed", reason: "answer-not-sendable", agpCode: null };
		}
		try {
			await send(message);
		} catch (error) {
			if (content.outcome === "failed") return;
			const code = (error as { code?: unknown } | null)?.code;
			const agpCode = typeof code === "string" ? code : null;
			await send(writeEnd(address, { outcome: "failed", reason: "answer-not-sendable", agpCode }) as unknown as JsonValue).catch(() => undefined);
		}
	};

	/** Serves one request delivered to an operation's endpoint. */
	const serve = async (operation: Served, payload: JsonObject, delivery: DeliveryContext, signal: AbortSignal): Promise<void> => {
		let evidenceAnswer: unknown = null;
		let evidenceFailed = false;
		if (evidence !== undefined) {
			try { evidenceAnswer = await evidence(delivery); } catch { evidenceFailed = true; }
		}
		const label = delivery.correlationId;
		const message = readMessage(payload);
		if (message === undefined || message.type !== "request" || message.attempt !== label || message.operation !== operation.name) {
			if (isAttemptId(label)) await reply({ invocation: invocationOfAttempt(label), attempt: label, operation: operation.name }, { outcome: "refused", refusal: malformedRequest() }, delivery);
			return;
		}
		const address: MessageAddress = { invocation: message.invocation, attempt: message.attempt, operation: operation.name };
		if (evidenceFailed) return reply(address, { outcome: "failed", reason: "operation-threw", agpCode: null }, delivery);
		const verdict = operation.prepared.judge(message.input);
		if (verdict.verdict === "misfit") return reply(address, { outcome: "refused", refusal: inputMisfit(operation.name, verdict.misfits) }, delivery);
		let result: unknown;
		try {
			result = await operation.handler(message.input, Object.freeze({ service, operation: operation.name, invocation: message.invocation, attempt: message.attempt, delivery, evidence: evidenceAnswer, signal }));
		} catch {
			return reply(address, { outcome: "failed", reason: "operation-threw", agpCode: null }, delivery);
		}
		if (!isResult(result)) return reply(address, { outcome: "failed", reason: "operation-threw", agpCode: null }, delivery);
		if (result.outcome === "refused") return reply(address, { outcome: "refused", refusal: result.refusal }, delivery);
		if (!isJson(result.answer)) return reply(address, { outcome: "failed", reason: "answer-not-sendable", agpCode: null }, delivery);
		return reply(address, { outcome: "answered", answer: result.answer as JsonValue }, delivery);
	};

	const expose = async (operation: Served): Promise<void> => {
		bindings.push(await node.expose(`${service}/${operation.name}` as EndpointName, (payload, context) => serve(operation, payload, context.delivery, context.signal)));
	};

	const description = (): Description => describe(service, declared);
	const describeShape = prepareShapeDocument(DESCRIBE_INPUT);
	if (!describeShape.accepted) throw new Error("shape-check refused the describe input shape; this is a defect of operation-call");
	await expose({
		name: DESCRIBE_OPERATION,
		prepared: describeShape,
		handler: () => ({ outcome: "answered", answer: description() as unknown as JsonValue }),
	});

	const declare = (declaration: OperationDeclaration, handler: OperationHandler): Promise<DeclarationOutcome> => {
		checkDeclarationForm(declaration);
		if (typeof handler !== "function") throw new TypeError("a declared operation needs its handler");
		if (closed) throw new Error("the host is closed");
		const run = queue.then(async (): Promise<DeclarationOutcome> => {
			const judged = judgeDeclaration(service, declaration, declared, served);
			if (!judged.accepted) return { declared: false, refusal: judged.refusal };
			served.add(judged.described.name);
			try {
				await expose({ name: judged.described.name, prepared: judged.prepared, handler });
			} catch (error) {
				served.delete(judged.described.name);
				throw error;
			}
			declared.push(judged.described);
			return { declared: true };
		});
		queue = run.catch(() => undefined);
		return run;
	};

	const host: OperationHost = Object.freeze({
		service,
		declare,
		description: () => copyJson(description() as unknown as JsonValue) as unknown as Description,
		async close(): Promise<void> {
			closed = true;
			await queue;
			await Promise.all(bindings.map((b) => b.close()));
		},
	});
	return { opened: true, host };
}
