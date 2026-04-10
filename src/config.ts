import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import type { DiscordManifest, RepoManifest, ResourceMap, ReviewChannelConfig } from "./types.js";

const repoManifestSchema = z.object({
  repos: z.array(
    z.object({
      id: z.string().min(1),
      owner: z.string().min(1),
      repo: z.string().min(1),
      localPath: z.string().min(1),
      summary: z.string().min(1),
      allowedPaths: z.array(z.string().min(1)).min(1),
    }),
  ),
});

const discordManifestSchema = z.object({
  reviewChannel: z
    .object({
      guildId: z.string().min(1),
      channelId: z.string().min(1),
      enabled: z.boolean(),
    })
    .optional(),
  routes: z.array(
    z.object({
      id: z.string().min(1),
      guildId: z.string().min(1),
      channelId: z.string().min(1),
      mode: z.enum(["thread", "channel"]),
      instructionRef: z.string().min(1),
      repoScopes: z.array(z.string().min(1)),
      enabled: z.boolean(),
    }),
  ),
});

const resourceMapSchema = z.object({
  areas: z.array(
    z.object({
      id: z.string().min(1),
      label: z.string().min(1),
      purpose: z.string().min(1),
      readableScopes: z.array(z.string().min(1)).min(1),
      typicalContent: z.string().min(1),
      usageGuidance: z.string().min(1),
    }),
  ),
});

export type AppConfig = {
  rootDir: string;
  manifestsDir: string;
  instructionsDir: string;
  transcriptsDir: string;
  sqlitePath: string;
  logsDir: string;
  repos: RepoManifest["repos"];
  routes: DiscordManifest["routes"];
  reviewChannel?: ReviewChannelConfig;
  resourceMap: ResourceMap["areas"];
};

async function loadYaml<T>(filePath: string, schema: z.ZodType<T>): Promise<T> {
  const raw = await readFile(filePath, "utf8");
  const parsed = parse(raw);
  return schema.parse(parsed);
}

export async function loadAppConfig(rootDir = process.env.STEVESBOT_ROOT ?? "."): Promise<AppConfig> {
  const resolvedRoot = path.resolve(rootDir);
  const manifestsDir = path.join(resolvedRoot, "resources", "manifests");
  const instructionsDir = path.join(resolvedRoot, "resources", "instructions");
  const transcriptsDir = path.join(resolvedRoot, "data", "transcripts");
  const sqlitePath = path.join(resolvedRoot, "data", "sqlite", "stevesbot.sqlite");
  const logsDir = path.join(resolvedRoot, "logs");

  const [repoManifest, discordManifest, resourceMap] = await Promise.all([
    loadYaml(path.join(manifestsDir, "repos.yaml"), repoManifestSchema),
    loadYaml(path.join(manifestsDir, "discord.yaml"), discordManifestSchema),
    loadYaml(path.join(manifestsDir, "resource-map.yaml"), resourceMapSchema),
  ]);

  return {
    rootDir: resolvedRoot,
    manifestsDir,
    instructionsDir,
    transcriptsDir,
    sqlitePath,
    logsDir,
    repos: repoManifest.repos,
    routes: discordManifest.routes,
    reviewChannel: discordManifest.reviewChannel,
    resourceMap: resourceMap.areas,
  };
}
