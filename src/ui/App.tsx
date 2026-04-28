import { useEffect, useRef } from 'react';
import { useChat } from '@/hooks/useChat';
import { Message } from '@/components/Message';
import { ChatInput } from '@/components/ChatInput';

export function App() {
  const { messages, isStreaming, sendMessage, cancel } = useChat();
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      {/* Header */}
      <header className="flex-shrink-0 border-b border-border px-6 py-4">
        <span className="text-xs uppercase tracking-widest text-muted-foreground">Agent Chat</span>
      </header>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-6">
        <div className="mx-auto flex max-w-3xl flex-col gap-5">
          {messages.length === 0 && (
            <p className="text-center text-sm text-muted-foreground">
              Ask the weather agent anything…
            </p>
          )}
          {messages.map(msg => (
            <Message key={msg.id} {...msg} />
          ))}
          <div ref={bottomRef} />
        </div>
      </div>

      {/* Input */}
      <ChatInput onSend={sendMessage} onCancel={cancel} isStreaming={isStreaming} />
    </div>
  );
}
