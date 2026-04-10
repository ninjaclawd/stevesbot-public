/**
 * P2P Tools
 *
 * Provides tool definitions and implementations for agents to interact
 * with the P2P network. These can be wired into the command channel
 * tool set alongside queryDb, searchKnowledgeBase, etc.
 */

import type { VDOBridge } from "../p2p/vdo-bridge.js";

export type P2PToolResult = {
  success: boolean;
  data?: unknown;
  error?: string;
};

/**
 * Tool catalog entries for agent tool selection.
 * Same format as the support pipeline's tool catalog.
 */
export function getP2PToolCatalog(): Array<{ name: string; description: string; args: string[] }> {
  return [
    {
      name: "p2pPeers",
      description: "List all peers currently connected to the P2P network, including their identity, role, skills, and status.",
      args: [],
    },
    {
      name: "p2pSend",
      description: "Send a text chat message over the P2P network. If target is omitted, broadcasts to all peers.",
      args: ["message", "target?"],
    },
    {
      name: "p2pHistory",
      description: "Get recent message history from the P2P network.",
      args: ["count?"],
    },
    {
      name: "p2pStatus",
      description: "Get the P2P bridge connection status, peer count, and subscriptions.",
      args: [],
    },
  ];
}

/**
 * Execute a P2P tool by name.
 */
export function invokeP2PTool(
  bridge: VDOBridge | undefined,
  toolName: string,
  args: Record<string, unknown>,
): P2PToolResult {
  if (!bridge || !bridge.isConnected()) {
    return { success: false, error: "P2P bridge is not connected." };
  }

  switch (toolName) {
    case "p2pPeers":
      return {
        success: true,
        data: {
          connectedCount: bridge.peers.connectedCount,
          peers: bridge.peers.toJSON(),
        },
      };

    case "p2pSend": {
      const message = String(args.message ?? "");
      if (!message) return { success: false, error: "Message is required." };
      const target = args.target ? String(args.target) : undefined;
      if (target) {
        bridge.chat(message, target);
      } else {
        bridge.chat(message);
      }
      return { success: true, data: { sent: true, to: target ?? "broadcast" } };
    }

    case "p2pHistory": {
      const count = Number(args.count) || 20;
      const history = bridge.bus.getHistory(count);
      // Summarize for the agent (don't dump full envelopes)
      const summary = history.map((m) => ({
        type: m.type,
        from: m.from.name || m.from.streamId,
        text: typeof m.payload === "object" && m.payload !== null
          ? (m.payload as Record<string, unknown>).text ?? (m.payload as Record<string, unknown>).message ?? (m.payload as Record<string, unknown>).kind ?? JSON.stringify(m.payload).slice(0, 200)
          : String(m.payload).slice(0, 200),
        ts: new Date(m.ts).toISOString(),
        topic: m.topic,
      }));
      return { success: true, data: summary };
    }

    case "p2pStatus":
      return {
        success: true,
        data: {
          connected: bridge.isConnected(),
          identity: bridge.identity,
          peerCount: bridge.peers.connectedCount,
          historySize: bridge.bus.historyCount,
          subscriptions: bridge.bus.getSubscriptions(),
          offlineQueues: bridge.bus.getOfflineQueuePeers(),
        },
      };

    default:
      return { success: false, error: `Unknown P2P tool: ${toolName}` };
  }
}
