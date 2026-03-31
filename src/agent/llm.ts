/**
 * llm.ts — DeepSeek API client with streaming support
 *
 * Supports:
 * - DeepSeek Chat API (deepseek-chat)
 * - DeepSeek Reasoner (deepseek-reasoner)
 * - Streaming SSE responses
 * - Non-streaming fallback
 */

export interface LLMOptions {
  apiKey: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  stream?: boolean;
}

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

const DEEPSEEK_BASE = 'https://api.deepseek.com';

/** Stream a chat completion, returning a ReadableStream of SSE chunks */
export function streamChat(
  messages: LLMMessage[],
  options: LLMOptions
): ReadableStream<Uint8Array> {
  const model = options.model ?? 'deepseek-chat';
  const maxTokens = options.maxTokens ?? 4096;
  const temperature = options.temperature ?? 0.7;

  return new ReadableStream({
    async start(controller) {
      try {
        const res = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${options.apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages,
            max_tokens: maxTokens,
            temperature,
            stream: true,
          }),
        });

        if (!res.ok) {
          const errText = await res.text();
          controller.enqueue(
            new TextEncoder().encode(`data: ${JSON.stringify({ error: { message: `DeepSeek API error: ${res.status}: ${errText}` } })}\n\n`)
          );
          controller.close();
          return;
        }

        const reader = res.body?.getReader();
        if (!reader) {
          controller.enqueue(
            new TextEncoder().encode(`data: ${JSON.stringify({ error: { message: 'No response body' } })}\n\n`)
          );
          controller.close();
          return;
        }

        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith('data: ')) continue;

            const data = trimmed.slice(6);
            if (data === '[DONE]') {
              controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
              continue;
            }

            try {
              const parsed = JSON.parse(data);
              const delta = parsed.choices?.[0]?.delta?.content;
              if (delta) {
                controller.enqueue(
                  new TextEncoder().encode(`data: ${JSON.stringify({ content: delta })}\n\n`)
                );
              }
            } catch {
              // Forward raw SSE line
              controller.enqueue(new TextEncoder().encode(`${trimmed}\n\n`));
            }
          }
        }

        // Flush remaining buffer
        if (buffer.trim()) {
          const trimmed = buffer.trim();
          if (trimmed.startsWith('data: ') && trimmed.slice(6) !== '[DONE]') {
            try {
              const parsed = JSON.parse(trimmed.slice(6));
              const delta = parsed.choices?.[0]?.delta?.content;
              if (delta) {
                controller.enqueue(
                  new TextEncoder().encode(`data: ${JSON.stringify({ content: delta })}\n\n`)
                );
              }
            } catch {
              // Ignore
            }
          }
        }

        controller.close();
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        controller.enqueue(
          new TextEncoder().encode(`data: ${JSON.stringify({ error: { message } })}\n\n`)
        );
        controller.close();
      }
    },
  });
}

/** Non-streaming chat completion */
export async function completeChat(
  messages: LLMMessage[],
  options: LLMOptions
): Promise<string> {
  const model = options.model ?? 'deepseek-chat';
  const maxTokens = options.maxTokens ?? 4096;
  const temperature = options.temperature ?? 0.7;

  const res = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${options.apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,
      temperature,
      stream: false,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`DeepSeek API error ${res.status}: ${errText}`);
  }

  const data = await res.json() as {
    choices: Array<{ message: { content: string } }>;
  };

  return data.choices?.[0]?.message?.content ?? '';
}

/** Summarize a conversation title using the LLM */
export async function generateTitle(
  messages: LLMMessage[],
  apiKey: string
): Promise<string> {
  try {
    const titleMessages: LLMMessage[] = [
      {
        role: 'system',
        content: 'Generate a very short title (max 6 words) for this conversation. Return ONLY the title, nothing else.',
      },
      ...messages.slice(0, 4),
    ];
    return await completeChat(titleMessages, {
      apiKey,
      maxTokens: 30,
      temperature: 0.3,
    });
  } catch {
    return 'Conversation';
  }
}
