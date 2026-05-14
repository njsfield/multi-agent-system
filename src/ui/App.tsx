import { useEffect, useRef, useState } from "react";
import { useChat } from "@/hooks/useChat";
import { useFlashcard } from "@/hooks/useFlashcard";
import { useTopics } from "@/hooks/useTopics";
import { Message } from "@/components/Message";
import { ChatInput } from "@/components/ChatInput";
import { FlashcardWidget } from "@/components/FlashcardWidget";
import { Mindmap } from "@/components/Mindmap";
import type { FlashcardFilter } from "@/lib/types";

export function App() {
  const { messages, isStreaming, sendMessage, cancel } = useChat();
  const { card, phase, reveal, submitScore, fetchNext } = useFlashcard();
  const { topics } = useTopics();
  const bottomRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<"chat" | "mindmap">("chat");
  const [flashcardFilter, setFlashcardFilter] = useState<FlashcardFilter>({});

  useEffect(() => {
    if (view === "chat")
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, view]);

  if (view === "mindmap") {
    return (
      <div className="flex h-dvh flex-col bg-background text-foreground">
        <header className="flex-shrink-0 border-b border-border px-6 py-4 flex items-center gap-4">
          <button
            onClick={() => setView("chat")}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            ← Back
          </button>
          <span className="text-xs uppercase tracking-widest text-muted-foreground">
            Mindmap
          </span>
        </header>
        <div className="flex-1 overflow-hidden">
          <Mindmap />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      <header className="flex-shrink-0 border-b border-border px-6 py-4 flex items-center justify-between">
        <span className="text-xs uppercase tracking-widest text-muted-foreground">
          Agent Chat
        </span>
        <button
          onClick={() => setView("mindmap")}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          🗺 Mindmap
        </button>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-6">
        <div className="mx-auto flex max-w-3xl flex-col gap-5">
          {messages.length === 0 && (
            <p className="text-center text-sm text-muted-foreground">
              Ask anything…
            </p>
          )}
          {messages.map((msg) => (
            <Message key={msg.id} {...msg} />
          ))}
          {card && (
            <FlashcardWidget
              card={card}
              phase={phase}
              onReveal={reveal}
              onScore={submitScore}
            />
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      <ChatInput
        onSend={sendMessage}
        onCancel={cancel}
        isStreaming={isStreaming}
        topics={topics}
        flashcardFilter={flashcardFilter}
        onFilterChange={setFlashcardFilter}
        onFetchFlashcard={() => fetchNext(flashcardFilter)}
        isFlashcardActive={phase === "question" || phase === "answer"}
      />
    </div>
  );
}
