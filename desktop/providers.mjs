import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const protocols = new Set(["openai-completions", "openai-responses", "anthropic-messages"]);
const validId = (id) => typeof id === "string" && /^verity-[a-f0-9-]{36}$/.test(id);
const validText = (value, limit) => typeof value === "string" && value.length <= limit && Boolean(value.trim());

function profileFields({ label, api, baseUrl, modelId }) {
  if (!validText(label, 120) || !validText(modelId, 256) || !protocols.has(api)) {
    throw new Error("Enter a provider name, protocol, and model ID");
  }
  const url = validText(baseUrl, 2048) && URL.parse(baseUrl);
  if (!url || !["https:", "http:"].includes(url.protocol) || url.username || url.password || url.hash || url.search) {
    throw new Error("Enter an HTTP or HTTPS base URL without credentials, a query, or a fragment");
  }
  return { label: label.trim(), api, baseUrl: url.href.replace(/\/$/, ""), modelId: modelId.trim() };
}

const publicProfile = ({ id, label, api, baseUrl, modelId }) => ({ id, label, api, baseUrl, modelId });

export function createProviderStore(file, safeStorage) {
  async function load() {
    const data = await readFile(file, "utf8").catch((error) => {
      if (error.code === "ENOENT") return "[]";
      throw new Error("Could not read provider settings");
    });
    try {
      const profiles = JSON.parse(data);
      const ids = new Set();
      return new Map(profiles.map(({ id, ciphertext, ...fields }) => {
        if (!validId(id) || ids.has(id) || !validText(ciphertext, 65536)) throw new Error();
        ids.add(id);
        return [id, { id, ...profileFields(fields), ciphertext }];
      }));
    } catch {
      throw new Error("Saved provider settings are invalid");
    }
  }

  async function replace(profiles) {
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(temp, JSON.stringify([...profiles.values()]), { flag: "wx", mode: 0o600 });
      await rename(temp, file);
    } catch {
      await rm(temp, { force: true }).catch(() => {});
      throw new Error("Could not save provider settings");
    }
  }

  async function withVault(action) {
    try {
      if (!await safeStorage.isAsyncEncryptionAvailable()
          || (process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text")) {
        throw new Error();
      }
      return await action();
    } catch {
      throw new Error("The system credential store is unavailable");
    }
  }

  return {
    list: async () => [...(await load()).values()].map(publicProfile),
    async save(input) {
      const fields = profileFields(input ?? {});
      const { id, apiKey = "" } = input;
      const profiles = await load();
      const previous = profiles.get(id);
      if (id !== undefined && !previous) throw new Error("Provider no longer exists");
      let ciphertext = previous?.ciphertext;
      if (apiKey !== "") {
        if (!validText(apiKey, 8192) || /[\u0000-\u0020\u007f]/.test(apiKey)) throw new Error("Enter a valid API key");
        ciphertext = await withVault(async () => (await safeStorage.encryptStringAsync(apiKey)).toString("base64"));
      } else if (!previous || previous.baseUrl !== fields.baseUrl || previous.api !== fields.api) {
        throw new Error("Enter an API key for this endpoint");
      }
      const record = { id: id ?? `verity-${randomUUID()}`, ...fields, ciphertext };
      profiles.set(record.id, record);
      await replace(profiles);
      return publicProfile(record);
    },
    async remove(id) {
      const profiles = await load();
      if (!profiles.delete(id)) throw new Error("Provider no longer exists");
      await replace(profiles);
    },
    async childEnv() {
      const profiles = [...(await load()).values()];
      if (!profiles.length) return {};
      return withVault(async () => ({
        VERITY_DESKTOP_PROVIDERS: JSON.stringify(profiles.map(publicProfile)),
        ...Object.fromEntries(await Promise.all(profiles.map(async ({ id, ciphertext }) => {
          const { result } = await safeStorage.decryptStringAsync(Buffer.from(ciphertext, "base64"));
          return [providerKeyVariable(id), result];
        }))),
      }));
    },
  };
}

export const providerKeyVariable = (id) => `VERITY_DESKTOP_KEY_${id.replaceAll("-", "_").toUpperCase()}`;
