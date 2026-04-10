#!/usr/bin/env tsx
import { fileURLToPath } from "node:url";
import path from "node:path";
import { validateSkills } from "../src/skill-validation.js";

function parseArgs(args: string[]): { format: "text" | "json"; skillIds: string[] } {
  const skillIds: string[] = [];
  let format: "text" | "json" = "text";

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      format = "json";
      continue;
    }
    if (arg === "--skill") {
      const skillId = args[index + 1];
      if (!skillId) {
        throw new Error("--skill requires a value");
      }
      skillIds.push(skillId);
      index += 1;
      continue;
    }
    throw new Error("Unknown argument: " + arg);
  }

  return { format, skillIds };
}

function renderText(results: Awaited<ReturnType<typeof validateSkills>>): string {
  const lines: string[] = [];
  for (const result of results) {
    lines.push(`${result.ok ? "PASS" : "FAIL"} ${result.skillId} [${result.mode}] ${result.summary}`);
    for (const check of result.checks) {
      lines.push(`  - ${check.ok ? "ok" : "fail"} ${check.name}: ${check.details}`);
    }
  }
  const passed = results.filter((result) => result.ok).length;
  lines.push("");
  lines.push(`Summary: ${passed}/${results.length} skills passed validation`);
  return lines.join("\n");
}

async function main(): Promise<void> {
  const { format, skillIds } = parseArgs(process.argv.slice(2));
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const results = await validateSkills({
    rootDir,
    skillIds: skillIds.length > 0 ? skillIds : undefined,
  });

  if (format === "json") {
    console.log(JSON.stringify(results, null, 2));
  } else {
    console.log(renderText(results));
  }

  if (results.some((result) => !result.ok)) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
