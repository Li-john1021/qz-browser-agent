import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const localEnvFile = fileURLToPath(new URL("../../.env.local", import.meta.url));

// Read only the selected Provider's credential; never load all local secrets into
// process.env, where unrelated test subprocesses could inherit them.
export function readTestApiKey(provider, {
  keyFile = "",
  env = process.env,
  envFile = localEnvFile,
  required = true,
} = {}) {
  const name = `${String(provider).toUpperCase().replace(/-/g, "_")}_API_KEY`;
  let apiKey;
  if (keyFile) {
    apiKey = readFileSync(resolve(keyFile), "utf8").trim();
  } else {
    const values = env[name] !== undefined
      ? env
      : existsSync(envFile) ? parseEnv(readFileSync(envFile, "utf8")) : {};
    apiKey = String(values[name] ?? "").trim();
  }
  if (!apiKey && required) {
    throw new Error(`Missing ${name}: set it in .env.local or the environment, or provide an explicit key file`);
  }
  return apiKey;
}
