import { useCallback, useRef, useState } from 'react';
import { streamSSE } from '@/lib/sseClient';

export interface UIMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  contentType: 'text' | 'markdown';
  isStreaming: boolean;
  cancelled?: boolean;
}

export function useChat() {
  const [messages, setMessages]     = useState<UIMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const controllerRef               = useRef<AbortController | null>(null);

  // Update the most recent assistant message in the list
  const patchLastAssistant = (patch: Partial<UIMessage>) => {
    setMessages(prev => {
      const idx = [...prev].reverse().findIndex(m => m.role === 'assistant');
      if (idx === -1) return prev;
      const i = prev.length - 1 - idx;
      return prev.map((m, j) => (j === i ? { ...m, ...patch } : m));
    });
  };

  const sendMessage = useCallback(async (text: string) => {
    if (!text.trim() || isStreaming) return;

    const assistantId = crypto.randomUUID();

    setMessages(prev => [
      ...prev,
      { id: crypto.randomUUID(), role: 'user', content: text, contentType: 'text', isStreaming: false },
      { id: assistantId,         role: 'assistant', content: '', contentType: 'text', isStreaming: true },
    ]);
    setIsStreaming(true);

    const controller  = new AbortController();
    controllerRef.current = controller;

    try {
      for await (const event of streamSSE('/chat', { message: text }, controller.signal)) {
        switch (event.type) {
          case 'token':
            // Append each token to the streaming bubble
            setMessages(prev => prev.map(m =>
              m.id === assistantId ? { ...m, content: m.content + (event.content ?? '') } : m,
            ));
            break;

          case 'message':
            if (event.role === 'assistant') {
              // Replace accumulated tokens with the final message (may include contentType)
              setMessages(prev => prev.map(m =>
                m.id === assistantId
                  ? { ...m, content: event.content ?? m.content, contentType: event.contentType ?? 'text', isStreaming: false }
                  : m,
              ));
            }
            break;

          case 'done':
            patchLastAssistant({ isStreaming: false });
            break;

          case 'error':
            patchLastAssistant({ content: `Error: ${event.error ?? 'unknown'}`, isStreaming: false });
            break;
        }
      }
    } catch (err) {
      const isAbort = (err as Error).name === 'AbortError';
      patchLastAssistant({
        isStreaming: false,
        cancelled: isAbort,
        // Keep partial content if we received some; otherwise show placeholder
        ...(isAbort ? {} : { content: `Error: ${(err as Error).message}` }),
      });
    } finally {
      setIsStreaming(false);
      controllerRef.current = null;
    }
  }, [isStreaming]);

  const cancel = useCallback(() => {
    controllerRef.current?.abort();
  }, []);

  return { messages, isStreaming, sendMessage, cancel };
}
