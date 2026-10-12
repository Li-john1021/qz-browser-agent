import assert from "node:assert/strict";

/** Check every authored instance of a component without depending on class ordering. */
export function assertClassTokens(html, component, required, message) {
  const instances = [...html.matchAll(/\bclass="([^"]*)"/gu)]
    .map(match => new Set(match[1].split(/\s+/u)))
    .filter(tokens => tokens.has(component));
  assert.ok(instances.length, `${message}: missing ${component}`);
  for (const tokens of instances) {
    for (const token of required) assert.ok(tokens.has(token), `${message}: ${component} needs ${token}`);
  }
}
