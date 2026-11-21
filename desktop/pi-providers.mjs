import { providerKeyVariable } from "./providers.mjs";

export default function (pi) {
  for (const { id, label, api, baseUrl, modelId } of JSON.parse(process.env.VERITY_DESKTOP_PROVIDERS ?? "[]")) {
    pi.registerProvider(id, {
      api,
      baseUrl,
      apiKey: `$${providerKeyVariable(id)}`,
      models: [{
        id: modelId, name: label, reasoning: false, input: ["text"], contextWindow: 8192, maxTokens: 2048,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      }],
    });
  }
}
