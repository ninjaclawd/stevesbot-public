import { execFile } from "node:child_process";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { AppConfig } from "../config.js";
import type { DiscordAttachmentRecord, DiscordEventRecord } from "../types.js";

const execFileAsync = promisify(execFile);
const MAX_IMAGE_WIDTH = 1920;
const MAX_IMAGE_HEIGHT = 1080;
const RESIZE_SCRIPT_PATH = fileURLToPath(new URL("./resize_image.py", import.meta.url));
const PYTHON_COMMAND_CANDIDATES = [
  process.env.STEVESBOT_PYTHON,
  "/usr/bin/python3",
  "python3",
  "/usr/bin/python",
  "python",
].filter((value): value is string => Boolean(value && value.trim()));

export type PreparedImageAttachment = {
  attachment: DiscordAttachmentRecord;
  imageDataUrl: string;
};

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "attachment";
}

async function downloadAttachment(urls: string[]): Promise<Buffer> {
  let lastError: unknown;
  for (const url of urls) {
    if (!url) {
      continue;
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const data = Buffer.from(await response.arrayBuffer());
      if (data.length === 0) {
        throw new Error("Attachment download was empty.");
      }
      return data;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Failed to download Discord attachment.");
}

function isImageContentType(contentType?: string): boolean {
  return typeof contentType === "string" && contentType.startsWith("image/");
}

export function isImageAttachment(attachment: DiscordAttachmentRecord): boolean {
  return attachment.kind === "image" || isImageContentType(attachment.contentType) || Boolean(attachment.width && attachment.height);
}

async function runResizeScript(rawPath: string, outputPath: string): Promise<{
  width: number;
  height: number;
  originalWidth: number;
  originalHeight: number;
}> {
  let lastError: unknown;
  for (const command of PYTHON_COMMAND_CANDIDATES) {
    try {
      const { stdout } = await execFileAsync(
        command,
        [RESIZE_SCRIPT_PATH, rawPath, outputPath, String(MAX_IMAGE_WIDTH), String(MAX_IMAGE_HEIGHT)],
        { timeout: 120_000, maxBuffer: 2 * 1024 * 1024 },
      );
      return JSON.parse(stdout) as {
        width: number;
        height: number;
        originalWidth: number;
        originalHeight: number;
      };
    } catch (error) {
      lastError = error;
      if (!(error instanceof Error) || !String((error as NodeJS.ErrnoException).code).includes("ENOENT")) {
        throw error;
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error("No usable Python interpreter was found for image resizing.");
}

export class LocalImageAttachmentProcessor {
  public constructor(private readonly config: AppConfig) {}

  public async prepareAttachment(event: DiscordEventRecord, attachment: DiscordAttachmentRecord): Promise<PreparedImageAttachment> {
    if (!isImageAttachment(attachment)) {
      throw new Error(`Attachment ${attachment.fileName} is not an image.`);
    }

    const baseDir = path.join(
      this.config.rootDir,
      "data",
      "attachments",
      safeSegment(event.guildId),
      safeSegment(event.threadId ?? event.channelId),
      safeSegment(event.messageId),
    );
    await mkdir(baseDir, { recursive: true });

    const fileStem = `${safeSegment(attachment.id)}-${safeSegment(path.parse(attachment.fileName).name)}`;
    const rawPath = path.join(baseDir, `${fileStem}.source`);
    const outputPath = path.join(baseDir, `${fileStem}.png`);

    const rawBytes = await downloadAttachment([attachment.url, attachment.proxyUrl ?? ""]);
    await writeFile(rawPath, rawBytes);

    try {
      const metadata = await runResizeScript(rawPath, outputPath);
      const outputBytes = await readFile(outputPath);
      return {
        attachment: {
          ...attachment,
          storedPath: outputPath,
          storedContentType: "image/png",
          storedWidth: metadata.width,
          storedHeight: metadata.height,
          width: attachment.width ?? metadata.originalWidth,
          height: attachment.height ?? metadata.originalHeight,
        },
        imageDataUrl: `data:image/png;base64,${outputBytes.toString("base64")}`,
      };
    } finally {
      await unlink(rawPath).catch(() => undefined);
    }
  }
}
