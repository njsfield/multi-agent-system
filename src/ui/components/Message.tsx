import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";
import { CodeBlock } from "./CodeBlock";
import type { UIMessage } from "@/hooks/useChat";

interface MessageProps extends UIMessage {}

export function Message({
  role,
  content,
  contentType,
  isStreaming,
  isThinking,
  cancelled,
}: MessageProps) {
  const isUser = role === "user";

  return (
    <div
      className={cn("flex w-full", isUser ? "justify-end" : "justify-start")}
    >
      <div
        className={cn(
          "flex max-w-[85%] flex-col gap-1",
          isUser ? "items-end" : "items-start",
        )}
      >
        <span className="px-1 text-[11px] uppercase tracking-widest text-muted-foreground">
          {isUser ? "you" : "assistant"}
        </span>

        <div
          className={cn(
            "rounded-xl px-4 py-3 text-sm leading-relaxed",
            isUser
              ? "rounded-br-sm bg-primary text-primary-foreground"
              : cn(
                  "rounded-bl-sm border border-border bg-secondary text-foreground",
                  cancelled && "italic text-muted-foreground",
                ),
          )}
        >
          {isThinking ? (
            <span className="animate-pulse text-muted-foreground">
              Thinking…
            </span>
          ) : isUser || (!isStreaming && contentType === "markdown") ? (
            isUser ? (
              <span className="whitespace-pre-wrap">{content}</span>
            ) : (
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  code: (props) => <CodeBlock {...props} />,
                  p: ({ children }) => (
                    <p className="mb-2 last:mb-0">{children}</p>
                  ),
                  ul: ({ children }) => (
                    <ul className="mb-2 list-disc pl-5 last:mb-0">
                      {children}
                    </ul>
                  ),
                  ol: ({ children }) => (
                    <ol className="mb-2 list-decimal pl-5 last:mb-0">
                      {children}
                    </ol>
                  ),
                  li: ({ children }) => <li className="mb-0.5">{children}</li>,
                  h1: ({ children }) => (
                    <h1 className="mb-2 text-lg font-bold">{children}</h1>
                  ),
                  h2: ({ children }) => (
                    <h2 className="mb-2 text-base font-semibold">{children}</h2>
                  ),
                  h3: ({ children }) => (
                    <h3 className="mb-1 font-semibold">{children}</h3>
                  ),
                  blockquote: ({ children }) => (
                    <blockquote className="mb-2 border-l-2 border-muted-foreground pl-3 italic text-muted-foreground">
                      {children}
                    </blockquote>
                  ),
                }}
              >
                {content}
              </ReactMarkdown>
            )
          ) : (
            <span className="whitespace-pre-wrap">
              {content}
              {isStreaming && (
                <span className="ml-0.5 inline-block h-[1em] w-[2px] translate-y-[1px] animate-pulse bg-current opacity-70" />
              )}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
