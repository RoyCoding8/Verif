// Saved-route construction on the pinned @earendil-works/pi-coding-agent SDK.
// A provider saved in Settings is registered onto a fresh ModelRuntime with
// no network access and no models.json, and its vault key is injected as a
// runtime credential — so Settings alone drives the route and normal use
// requires no environment variables. Errors become actionable reasons and
// never contain key material.

export async function createSavedRouteRuntime({ id: providerId, label, protocol, baseUrl, modelId, apiKey }) {
  const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
  const runtime = await ModelRuntime.create({ allowModelNetwork: false, modelsPath: null });
  runtime.registerProvider(providerId, {
    name: label || providerId,
    baseUrl,
    api: protocol,
    models: [chatModel(modelId)],
  });
  await runtime.setRuntimeApiKey(providerId, apiKey);
  const model = runtime.getModel(providerId, modelId);
  if (!model) throw new Error(`model ${modelId} could not be registered for provider ${providerId}`);
  if (!runtime.hasConfiguredAuth(providerId)) throw new Error(`provider ${providerId} has no configured credentials`);
  return { runtime, model, providerId, modelId };
}

function chatModel(modelId) {
  return {
    type: 'chat',
    id: modelId,
    name: modelId,
    reasoning: false,
    input: ['text'],
    // Conservative per-million-token unit costs for an unknown model: zero
    // cost would defeat the controller's dollar-ceiling reservation.
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    contextWindow: 128000,
    maxTokens: 8192,
  };
}
