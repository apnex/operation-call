/**
 * Public surface of operation-call: exactly the capabilities CONTRACT.md lists, and nothing else.
 * createCaller - honest-call-ending, caller-chosen-bound, invocation-identity, request-correlation,
 *   not-delivered-signal, call-refusal and advertiser-instance-select: the caller half over AGP.
 * createOperationHost - serve-named-operations, operation-descriptions, declared-shape-validation (carried
 *   from shape-check), call-refusal, request-correlation and peer-identity-evidence (carried from AGP): the
 *   host half over AGP.
 * readCallEnding - honest-call-ending: reads a candidate ending of any caller as plain data (zorg's D54, D55).
 * readRefusalRecord - call-refusal: reads a candidate refusal as plain data in EM9's form (zorg's D54, D55).
 * readCallRequest - caller-chosen-bound: reads each field of a call request once and snapshots its input (EM12).
 * systemCallClock, systemIdentitySource - the default ports a caller reads its bound's clock, and its
 *   identities' time and randomness, through.
 * The message format is `@apnex/operation-call/message-format`; the caller contract suite is
 * `@apnex/operation-call/caller-suite`. answer-in-parts and cancel-invocation are deferred (zorg's D15).
 */
export { createCaller, MAX_BOUND_MS, readCallRequest, type Caller, type CallerOptions } from "./caller.js";
export { readCallEnding } from "./call-ending.js";
export { readRefusalRecord } from "./refusal.js";
export { createOperationHost, type DeclarationOutcome, type DeliveryContext, type EvidenceFunction, type HostOpening, type HostOptions, type OperationContext, type OperationHandler, type OperationHost, type OperationResult } from "./host.js";
export { DECLARATION_LIMITS, type AnswerMode, type DescribedOperation, type Description, type HostRefusal, type HostRefusalCode, type OperationDeclaration } from "./declarations.js";
export { systemCallClock, systemIdentitySource, type CallClock, type ClockTimer } from "./system-ports.js";
export type { IdentitySource } from "./names.js";
export type { AnsweredEnding, CallEnding, CallLayerAddress, CallLayerEnding, CallLayerNotDeliveredEnding, CallLayerUnknownEnding, CallLayerUnknownReason, CallRequest, DeliveryReport, EndingAddress, HopNotDeliveredEnding, HopUnknownEnding, HopUnknownReason, NotDeliveredEnding, OperationCaller, RefusedEnding, UnknownEnding, UnknownReason } from "./call-types.js";
export type { CallRefusalCode, RefusalRecord } from "./refusal.js";
export type { JsonInput, JsonObject, JsonValue } from "@apnex/shape-check";
