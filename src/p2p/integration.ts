/**
 * StevesBot P2P Integration
 *
 * Wires the P2P module into stevesbot's pipeline and command channel.
 * This is the ONLY file in src/p2p/ that imports from stevesbot code.
 */

import { randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";
import path from "node:path";
import type { AppConfig } from "../config.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DatabaseLike = Record<string, any>;
import { VDOBridge, type VDOBridgeOptions } from "./vdo-bridge.js";
import type { MessageEnvelope } from "./protocol.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type P2PIntegrationOptions = {
  config: AppConfig;
  database: DatabaseLike;
  /** Peers allowed to send commands. Default: all. */
  commandAllowList?: string[];
};

export type PipelineEventSummary = {
  kind: "pipeline_run";
  route: string;
  outcome: string;
  threadKey: string;
  timestamp: number;
  category?: string;
  confidence?: number;
};

// ── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create and configure a VDOBridge for stevesbot.
 * Reads VDON_* env vars, wires pipeline event broadcasting, and sets up
 * inbound command handling.
 */
export function createStevesP2PBridge(options: P2PIntegrationOptions): VDOBridge {
  const room = process.env.VDON_ROOM;
  if (!room) {
    const generated = "clawd_" + randomBytes(16).toString("hex");
    console.log(`[P2P] No VDON_ROOM set. Generated room name: ${generated}`);
    console.log(`[P2P] Save this to your .env file as VDON_ROOM=${generated}`);
    // Use the generated name for this session
    process.env.VDON_ROOM = generated;
  }

  const streamId = process.env.VDON_STREAM_ID ?? "stevesbot_" + randomBytes(4).toString("hex");
  const password = parsePassword(process.env.VDON_PASSWORD);
  const host = process.env.VDON_HOST ?? "wss://wss.vdo.ninja";
  const forceTurn = process.env.VDON_FORCE_TURN === "true";
  const debug = process.env.VDON_DEBUG === "true";

  const bridgeOptions: VDOBridgeOptions = {
    room: process.env.VDON_ROOM!,
    streamId,
    identity: {
      streamId,
      role: "support-bot",
      name: process.env.VDON_NAME ?? "StevesBot",
    },
    password,
    host,
    forceTurn,
    debug,
    skills: ["discord-support", "kb-search", "repo-search", "code-search"],
    topics: ["events", "bots", "support"],
  };

  const bridge = new VDOBridge(bridgeOptions);

  // Wire command handling
  const allowList = options.commandAllowList ??
    (process.env.VDON_COMMAND_ALLOW ? process.env.VDON_COMMAND_ALLOW.split(",").map((s) => s.trim()) : null);

  bridge.bus.on("message:command", (envelope: MessageEnvelope) => {
    handleIncomingCommand(bridge, options, envelope, allowList);
  });

  // Log peer events
  bridge.on("peer:announce", (info: { streamId: string; identity: unknown; announce: unknown }) => {
    console.log(`[P2P] Peer announced: ${info.streamId}`, JSON.stringify(info.announce));
  });

  // File-based P2P event logging
  const logPath = path.join(options.config.rootDir, "logs", "p2p.log");
  const logP2P = (dir: string, type: string, peer: string, summary: string) => {
    const line = `[${new Date().toISOString()}] [${dir}] ${type} ${peer} ${summary}\n`;
    try { appendFileSync(logPath, line); } catch { /* best effort */ }
  };

  bridge.bus.on("message", (env: MessageEnvelope) => {
    const text = typeof env.payload === "object" && env.payload !== null
      ? (env.payload as Record<string, unknown>).text as string ?? (env.payload as Record<string, unknown>).kind as string ?? ""
      : String(env.payload);
    logP2P("in", env.type, env.from.name || env.from.streamId, text.slice(0, 200));
  });

  bridge.on("peer:connected", (info: { streamId: string }) => {
    logP2P("sys", "peer_connected", info.streamId, "");
  });

  bridge.on("peer:disconnected", (info: { streamId: string }) => {
    logP2P("sys", "peer_disconnected", info.streamId, "");
  });

  return bridge;
}

/**
 * Broadcast a pipeline run result to the P2P network.
 * Call this from wherever the pipeline completes (index.ts or discord bot).
 */
export function broadcastPipelineEvent(bridge: VDOBridge, summary: PipelineEventSummary): void {
  if (!bridge.isConnected()) return;
  bridge.publishEvent("events", "pipeline_run", summary);
}

// ── Command Handling ───────────────────────────────────────────────────────

function handleIncomingCommand(
  bridge: VDOBridge,
  options: P2PIntegrationOptions,
  envelope: MessageEnvelope,
  allowList: string[] | null,
): void {
  const from = envelope.from.streamId;

  // Check allowlist
  if (allowList && !allowList.includes(from)) {
    bridge.bus.send(from, "command_response", {
      error: "unauthorized",
      message: "You are not authorized to send commands.",
    });
    return;
  }

  const payload = envelope.payload as Record<string, unknown> | undefined;
  const command = payload?.command as string | undefined;
  if (!command) return;

  // Handle built-in P2P commands
  switch (command) {
    case "peers":
      bridge.bus.send(from, "command_response", {
        command: "peers",
        result: bridge.peers.toJSON(),
      });
      break;

    case "status":
      bridge.bus.send(from, "command_response", {
        command: "status",
        result: {
          connected: bridge.isConnected(),
          peerCount: bridge.peers.connectedCount,
          historySize: bridge.bus.historyCount,
          subscriptions: bridge.bus.getSubscriptions(),
          identity: bridge.identity,
          announce: bridge.getAnnouncePayload(),
        },
      });
      break;

    case "history": {
      const count = (payload?.args as Record<string, unknown>)?.count as number ?? 50;
      bridge.bus.send(from, "command_response", {
        command: "history",
        result: bridge.bus.getHistory(count),
      });
      break;
    }

    case "health": {
      // Query database for basic health stats (works with both queryGet and prepare().get() APIs)
      try {
        const dbGet = (sql: string): Record<string, number> | undefined => {
          const db = options.database as Record<string, unknown>;
          if (typeof db.queryGet === "function") return db.queryGet(sql);
          if (typeof db.db === "object" && db.db !== null) {
            const inner = db.db as Record<string, unknown>;
            if (typeof inner.prepare === "function") return (inner.prepare(sql) as { get: () => Record<string, number> }).get();
          }
          return undefined;
        };
        const totalRuns = dbGet("SELECT COUNT(*) as c FROM decision_log")?.c ?? 0;
        const approved = dbGet("SELECT COUNT(*) as c FROM decision_log WHERE outcome='approved'")?.c ?? 0;
        const todayRuns = dbGet("SELECT COUNT(*) as c FROM decision_log WHERE created_at >= date('now')")?.c ?? 0;
        bridge.bus.send(from, "command_response", {
          command: "health",
          result: {
            totalRuns,
            approved,
            todayRuns,
            approvalRate: totalRuns > 0 ? Math.round((approved / totalRuns) * 100) : 0,
            uptime: process.uptime(),
          },
        });
      } catch {
        bridge.bus.send(from, "command_response", {
          command: "health",
          error: "Failed to query database",
        });
      }
      break;
    }

    default:
      bridge.bus.send(from, "command_response", {
        command,
        error: "unknown_command",
        message: `Unknown command: ${command}. Available: peers, status, history, health`,
      });
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function parsePassword(raw?: string): string | false | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (raw === "false") return false;
  return raw;
}
