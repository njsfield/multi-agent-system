export interface SSEEvent {
  type: 'token' | 'message' | 'result' | 'error' | 'done' | 'event';
  content?: string;
  role?: string;
  source?: string;
  contentType?: 'text' | 'markdown';
  error?: string;
  [key: string]: unknown;
}

export async function* streamSSE(
  url: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
): AsyncGenerator<SSEEvent> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
  if (!response.body) throw new Error('No response body');

  const reader  = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer    = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() ?? '';

    for (const part of parts) {
      for (const line of part.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (!raw) continue;
        try {
          yield JSON.parse(raw) as SSEEvent;
        } catch {
          // skip malformed events
        }
      }
    }
  }
}
