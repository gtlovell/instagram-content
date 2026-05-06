export function requireEnv(name, context = "command") {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name} env var required for ${context}.`);
  }
  return value;
}

export async function withRetry(label, fn, options = {}) {
  const retries = options.retries ?? 2;
  const baseDelayMs = options.baseDelayMs ?? 750;

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt === retries) break;
      const delay = baseDelayMs * 2 ** attempt;
      console.warn(`  ${label} failed (${err.message}). Retrying in ${delay}ms...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}
