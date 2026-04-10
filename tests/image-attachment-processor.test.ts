import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { tmpdir } from "node:os";
import type { AppConfig } from "../src/config.js";
import { LocalImageAttachmentProcessor } from "../src/media/image-attachment-processor.js";

test("LocalImageAttachmentProcessor downloads and resizes oversized images to 1920x1080 or smaller", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "stevesbot-image-"));
  const sourcePath = path.join(tempDir, "source.png");
  const config: AppConfig = {
    rootDir: tempDir,
    manifestsDir: path.join(tempDir, "resources", "manifests"),
    instructionsDir: path.join(tempDir, "resources", "instructions"),
    transcriptsDir: path.join(tempDir, "data", "transcripts"),
    sqlitePath: path.join(tempDir, "data", "sqlite", "stevesbot.sqlite"),
    logsDir: path.join(tempDir, "logs"),
    repos: [],
    routes: [],
    reviewChannel: undefined,
    resourceMap: [],
  };

  let server;
  try {
    execFileSync("/usr/bin/python3", [
      "-c",
      "from PIL import Image; import sys; Image.new('RGB', (2800, 1600), (255, 0, 0)).save(sys.argv[1])",
      sourcePath,
    ]);

    server = createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "image/png" });
      response.end(readFileSync(sourcePath));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Server did not provide an address.");
    }

    const processor = new LocalImageAttachmentProcessor(config);
    const prepared = await processor.prepareAttachment(
      {
        guildId: "444444444444444444",
        channelId: "777777777777777777",
        messageId: "img-msg-1",
        authorId: "user-1",
        authorName: "alice",
        content: "",
        createdAt: "2026-03-12T10:00:00.000Z",
      },
      {
        id: "att-1",
        fileName: "huge.png",
        url: `http://127.0.0.1:${address.port}/huge.png`,
        contentType: "image/png",
        kind: "image",
      },
    );

    assert.equal(prepared.attachment.storedContentType, "image/png");
    assert.ok((prepared.attachment.storedWidth ?? 0) <= 1920);
    assert.ok((prepared.attachment.storedHeight ?? 0) <= 1080);
    assert.ok(prepared.attachment.storedPath);
    assert.ok(prepared.imageDataUrl.startsWith("data:image/png;base64,"));
  } finally {
    server?.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});
