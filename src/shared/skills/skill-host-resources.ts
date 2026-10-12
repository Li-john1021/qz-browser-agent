import type { ToolSchema } from "../contracts/tool.js";
import { SKILL_MANIFEST_FORMAT, SKILL_MANIFEST_SCHEMA_VERSION } from "./skill-format.js";

interface SkillHostPackage {
  id: string; displayName: string; version: string; description: string;
  category: { id: string; label: string };
  tools: Readonly<Record<string, { description: string; parameters: ToolSchema }>>;
  manifestTitle: string; manifestDescription: string; scriptDescription: string;
}

/** Preserve the portable Skill declaration and script IR from the same core tool specifications. */
export function createSkillHostResources({ tools: specs, manifestTitle, manifestDescription, scriptDescription, ...metadata }: SkillHostPackage) {
  const tools = Object.entries(specs).map(([name, spec]) => ({
    name,
    capabilityId: name,
    description: spec.description,
    script: `scripts/${name.replaceAll("_", "-")}.js`,
    runtime: "host",
    needsPage: false,
    includeTrace: false,
    parameters: spec.parameters,
  }));
  const manifest = {
    format: SKILL_MANIFEST_FORMAT,
    schemaVersion: SKILL_MANIFEST_SCHEMA_VERSION,
    ...metadata,
    tools,
  };
  return Object.freeze([
    Object.freeze({
      path: "plugin.json",
      type: "json",
      title: manifestTitle,
      description: manifestDescription,
      content: JSON.stringify(manifest, null, 2),
    }),
    ...tools.map(tool => Object.freeze({
      path: tool.script,
      type: "script",
      title: tool.script.split("/").pop(),
      description: scriptDescription,
      content: `const payload = { ...args };
delete payload.$plugin;
delete payload.timeout;
delete payload.timeoutMs;
return await tools.${tool.name}(payload);`,
    })),
  ]);
}
