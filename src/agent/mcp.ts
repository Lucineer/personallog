/**
 * mcp.ts — MCP (Model Context Protocol) server for visiting agents
 *
 * Exposes tools that external agents can call via JSON-RPC.
 * This lets other personallog instances or MCP clients interact
 * with this agent programmatically.
 */

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface MCPRequest {
  jsonrpc: '2.0';
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface MCPResponse {
  jsonrpc: '2.0';
  id?: string | number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

const TOOLS: MCPTool[] = [
  {
    name: 'chat',
    description: 'Send a message to this agent and receive a response',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'The message to send' },
        context: { type: 'string', description: 'Optional context about the requesting agent' },
      },
      required: ['message'],
    },
  },
  {
    name: 'get_profile',
    description: 'Get the public profile of this agent',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'list_files',
    description: 'List files in this agent\'s repo',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path to list' },
      },
    },
  },
  {
    name: 'read_file',
    description: 'Read a file from this agent\'s repo',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to read' },
      },
      required: ['path'],
    },
  },
  {
    name: 'get_capabilities',
    description: 'Get a list of this agent\'s capabilities',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

/** Handle an MCP JSON-RPC request */
export async function handleMCPRequest(
  request: MCPRequest,
  memory: KVNamespace,
  files: KVNamespace | undefined,
  githubToken: string | undefined,
  githubRepo: string | undefined
): Promise<MCPResponse> {
  const { method, params, id } = request;

  switch (method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: 'personallog-ai',
            version: '1.0.0',
          },
        },
      };

    case 'tools/list':
      return {
        jsonrpc: '2.0',
        id,
        result: { tools: TOOLS },
      };

    case 'tools/call': {
      const toolName = params?.name as string;
      const toolParams = (params?.arguments ?? {}) as Record<string, string>;

      switch (toolName) {
        case 'get_profile':
          return await handleGetProfile(memory, id);

        case 'list_files': {
          const { listFiles } = await import('./git.js');
          const fileList = await listFiles(githubToken, githubRepo, files, toolParams.path ?? '');
          return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(fileList, null, 2) }] } };
        }

        case 'read_file': {
          const { readFile } = await import('./git.js');
          const file = await readFile(githubToken, githubRepo, files, toolParams.path);
          if (!file) {
            return { jsonrpc: '2.0', id, error: { code: -32602, message: 'File not found' } };
          }
          return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: file.content }] } };
        }

        case 'get_capabilities':
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  agent: 'personallog-ai',
                  version: '1.0.0',
                  capabilities: ['chat', 'file_browse', 'memory', 'a2a', 'mcp'],
                  channels: ['web', 'telegram', 'discord', 'whatsapp'],
                }),
              }],
            },
          };

        case 'chat':
          // For MCP chat, we'd need to call the LLM — return a placeholder
          // The worker will handle the full flow
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{
                type: 'text',
                text: 'Direct MCP chat requires streaming. Use the /api/chat endpoint instead.',
              }],
            },
          };

        default:
          return {
            jsonrpc: '2.0',
            id,
            error: { code: -32601, message: `Unknown tool: ${toolName}` },
          };
      }
    }

    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };

    default:
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Unknown method: ${method}` },
      };
  }
}

async function handleGetProfile(memory: KVNamespace, id: string | number | undefined): Promise<MCPResponse> {
  const { getSoul } = await import('./soul.js');
  const soul = await getSoul(memory);
  // Extract just the name section — don't expose full soul to other agents
  const nameMatch = soul.match(/(?:name|Name)[:\s]+([^\n]+)/);
  const name = nameMatch?.[1]?.trim() ?? 'Personallog Agent';

  return {
    jsonrpc: '2.0',
    id,
    result: {
      content: [{
        type: 'text',
        text: JSON.stringify({
          name,
          type: 'personallog-ai',
          version: '1.0.0',
          description: 'A personal AI agent living in a repository',
          public: true,
        }),
      }],
    },
  };
}
