/**
 * a2a.ts — Agent-to-Agent protocol handler
 *
 * Implements a simple A2A protocol for inter-agent communication.
 * Other agents can discover, greet, and exchange messages with this agent.
 */

export interface A2AMessage {
  type: 'discover' | 'greet' | 'message' | 'query' | 'response' | 'error';
  from: string;
  to: string;
  payload: Record<string, unknown>;
  timestamp: number;
  id: string;
}

export interface A2AAgentCard {
  name: string;
  version: string;
  description: string;
  capabilities: string[];
  endpoints: {
    a2a: string;
    mcp: string;
    chat: string;
  };
}

/** Generate this agent's card */
export async function getAgentCard(
  memory: KVNamespace,
  origin: string
): Promise<A2AAgentCard> {
  const { getSoul } = await import('./soul.js');
  const soul = await getSoul(memory);
  const nameMatch = soul.match(/(?:name|Name)[:\s]+([^\n]+)/);
  const name = nameMatch?.[1]?.trim() ?? 'Personallog Agent';

  return {
    name,
    version: '1.0.0',
    description: 'A personal AI agent living in a repository',
    capabilities: ['chat', 'memory', 'file_browse', 'mcp', 'a2a'],
    endpoints: {
      a2a: `${origin}/api/a2a`,
      mcp: `${origin}/api/mcp`,
      chat: `${origin}/api/chat`,
    },
  };
}

/** Handle an incoming A2A message */
export async function handleA2AMessage(
  message: A2AMessage,
  memory: KVNamespace,
  origin: string
): Promise<A2AMessage> {
  switch (message.type) {
    case 'discover':
      return {
        type: 'response',
        from: 'personallog-ai',
        to: message.from,
        payload: { card: await getAgentCard(memory, origin) },
        timestamp: Date.now(),
        id: generateId(),
      };

    case 'greet':
      // Store the visiting agent's info
      await memory.put(
        `a2a:agent:${message.from}`,
        JSON.stringify({
          name: message.payload.name ?? message.from,
          lastSeen: Date.now(),
          greeted: true,
        })
      );

      return {
        type: 'response',
        from: 'personallog-ai',
        to: message.from,
        payload: {
          greeting: `Hello from personallog-ai! I acknowledge you, ${message.payload.name ?? message.from}.`,
          card: await getAgentCard(memory, origin),
        },
        timestamp: Date.now(),
        id: generateId(),
      };

    case 'query':
      // Record the interaction
      await memory.put(
        `a2a:query:${message.id}`,
        JSON.stringify({ ...message, receivedAt: Date.now() })
      );

      return {
        type: 'response',
        from: 'personallog-ai',
        to: message.from,
        payload: {
          status: 'received',
          message: 'Query received. For full interaction, use the MCP tools endpoint.',
        },
        timestamp: Date.now(),
        id: generateId(),
      };

    case 'message':
      // Store the message for the owner to see
      await memory.put(
        `a2a:message:${message.id}`,
        JSON.stringify({ ...message, receivedAt: Date.now() })
      );

      return {
        type: 'response',
        from: 'personallog-ai',
        to: message.from,
        payload: { status: 'delivered' },
        timestamp: Date.now(),
        id: generateId(),
      };

    default:
      return {
        type: 'error',
        from: 'personallog-ai',
        to: message.from,
        payload: { error: `Unknown message type: ${message.type}` },
        timestamp: Date.now(),
        id: generateId(),
      };
  }
}

function generateId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
