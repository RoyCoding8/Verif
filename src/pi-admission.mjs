// Shared admission guard for Pi model-runtime transport entries.
//
// The request entries of the pinned @earendil-works/pi-coding-agent 1.5.2
// ModelRuntime (dist/core/model-runtime.d.ts) are the only paths that reach
// a provider. Deferred entries take a DeferredHandle whose billed usage they
// cannot see, so they are refused rather than priced. Every admitted entry
// is priced from the model catalog before the transport call, never after.
import {
  boundFromCatalog,
  checkedRequestBound,
  requestBoundMicros,
} from "./cost-ceiling.mjs";

export const CONTEXT_ENTRY_METHODS = ["stream", "complete", "streamSimple", "completeSimple", "generateImages", "classify"];
export const DEFERRED_ENTRY_METHODS = ["streamDeferred", "fetchDeferred"];

export function admissionRuntime(runtime, admit, refuse) {
  return new Proxy(runtime, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      const bound = value.bind(target);
      if (DEFERRED_ENTRY_METHODS.includes(property)) return () => refuse(property);
      if (!CONTEXT_ENTRY_METHODS.includes(property)) return bound;
      return (...args) => {
        const [requestModel, context] = args;
        admit(requestModel, context);
        return bound(...args);
      };
    },
  });
}

// Common cost math for one transport entry: check the derived catalog bound
// against the pinned record (route identity plus upward drift), then
// over-approximate the worst-case cost in micro-USD from the context bytes.
export function pricedRequestBound({ pinned, requestModel, context }) {
  const record = pinned ? checkedRequestBound(pinned, boundFromCatalog(requestModel)) : boundFromCatalog(requestModel);
  const inputBytes = Buffer.byteLength(JSON.stringify(context ?? null), "utf8");
  return { record, boundMicros: requestBoundMicros(record, inputBytes) };
}
