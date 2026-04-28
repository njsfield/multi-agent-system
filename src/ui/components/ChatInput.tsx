import { FormEvent, KeyboardEvent, useRef } from 'react';
import { Send, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface ChatInputProps {
  onSend: (message: string) => void;
  onCancel: () => void;
  isStreaming: boolean;
}

export function ChatInput({ onSend, onCancel, isStreaming }: ChatInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  const submit = () => {
    const value = inputRef.current?.value.trim();
    if (!value || isStreaming) return;
    inputRef.current!.value = '';
    onSend(value);
  };

  const handleKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
  };

  return (
    <div className="border-t border-border bg-background px-4 py-3">
      <div className="mx-auto flex max-w-3xl items-center gap-2">
        <Input
          ref={inputRef}
          placeholder="Ask something…"
          onKeyDown={handleKey}
          disabled={isStreaming}
          autoFocus
          className="flex-1"
        />

        {isStreaming ? (
          <Button variant="destructive" size="icon" onClick={onCancel} title="Stop">
            <Square className="h-4 w-4 fill-current" />
          </Button>
        ) : (
          <Button size="icon" onClick={submit} title="Send">
            <Send className="h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  );
}
