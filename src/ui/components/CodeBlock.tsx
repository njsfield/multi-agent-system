import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { ComponentPropsWithoutRef } from 'react';

type CodeProps = ComponentPropsWithoutRef<'code'> & { inline?: boolean };

export function CodeBlock({ inline, className, children, ...props }: CodeProps) {
  const language = /language-(\w+)/.exec(className ?? '')?.[1] ?? '';
  const code     = String(children).replace(/\n$/, '');

  if (inline) {
    return (
      <code
        className="rounded bg-muted px-[0.3em] py-[0.15em] font-mono text-[0.9em] text-foreground"
        {...props}
      >
        {code}
      </code>
    );
  }

  return (
    <div className="my-3 overflow-hidden rounded-lg border border-border">
      {language && (
        <div className="flex items-center justify-between border-b border-border bg-muted px-4 py-1.5">
          <span className="font-mono text-xs text-muted-foreground">{language}</span>
        </div>
      )}
      <SyntaxHighlighter
        language={language || 'text'}
        style={oneDark}
        customStyle={{
          margin: 0,
          borderRadius: 0,
          background: 'hsl(222 47% 7%)',
          fontSize: '0.85rem',
          padding: '1rem',
        }}
        showLineNumbers={code.split('\n').length > 4}
        wrapLongLines
      >
        {code}
      </SyntaxHighlighter>
    </div>
  );
}
