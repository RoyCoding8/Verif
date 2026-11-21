const hasControlCharacter = /\p{Cc}/u;

export function normalizeModelRoute(route) {
  if (route === undefined) return undefined;
  if (!Array.isArray(route) || route.length === 0) {
    throw new TypeError('modelRoute must be a nonempty array');
  }

  const seen = new Set();
  return Array.from(route, (entry, index) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new TypeError(`modelRoute[${index}] must be an object`);
    }
    const keys = Reflect.ownKeys(entry);
    if (keys.length !== 2 || !keys.includes('provider') || !keys.includes('model')) {
      throw new TypeError(`modelRoute[${index}] must contain only provider and model`);
    }

    const { provider, model } = entry;
    for (const [name, value] of [['provider', provider], ['model', model]]) {
      if (typeof value !== 'string' || value.length === 0 || hasControlCharacter.test(value) || value.trim() !== value) {
        throw new TypeError(`modelRoute[${index}].${name} must be a nonempty trimmed string without control characters`);
      }
    }

    const identity = JSON.stringify([provider, model]);
    if (seen.has(identity)) throw new TypeError(`modelRoute[${index}] duplicates an approved model`);
    seen.add(identity);
    return { provider, model };
  });
}

export function selectModelRoute(route, attemptNumber) {
  if (!Number.isInteger(attemptNumber) || attemptNumber < 1) {
    throw new RangeError('attemptNumber must be a positive integer');
  }
  const approved = normalizeModelRoute(route);
  if (approved === undefined) return undefined;
  return approved[Math.min(attemptNumber - 1, approved.length - 1)];
}
