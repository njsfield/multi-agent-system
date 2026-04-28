import path from 'path';
import express, { Application, Request, Response } from 'express';

export type StreamItem = Record<string, unknown>;
export type StreamFactory = (userMessage: string, signal: AbortSignal) => AsyncGenerator<unknown>;

// ---------------------------------------------------------------------------
// Markdown detection — runs on the server to tag messages for the frontend
// ---------------------------------------------------------------------------

function isMarkdown(text: string): boolean {
  return (
    /^#{1,6}\s/m.test(text) ||          // headings
    /^\s*[-*+]\s/m.test(text) ||        // unordered list
    /^\s*\d+\.\s/m.test(text) ||        // ordered list
    /`[^`]+`/.test(text) ||             // inline code
    /^```/m.test(text) ||               // fenced code block
    /\*\*[^*]+\*\*/.test(text) ||       // bold
    /^>\s/m.test(text)                  // blockquote
  );
}

// ---------------------------------------------------------------------------
// SSE serialisation
// ---------------------------------------------------------------------------

export function serializeItem(item: unknown): StreamItem {
  if (item == null) return { type: 'data' };
  const obj = item as Record<string, unknown>;

  if (obj['type'] === 'token' && 'content' in obj) {
    return { type: 'token', content: obj['content'], source: obj['source'] ?? 'assistant' };
  }
  if ('role' in obj && 'content' in obj) {
    const content     = String(obj['content'] ?? '');
    const contentType = isMarkdown(content) ? 'markdown' : 'text';
    return { type: 'message', role: obj['role'], source: obj['source'] ?? 'unknown', content, contentType };
  }
  if ('finalResult' in obj) {
    return { type: 'result', finalResult: obj['finalResult'], iterationsCompleted: obj['iterationsCompleted'] };
  }
  if ('type' in obj) {
    return { type: 'event', event: obj['type'], data: obj['data'] };
  }
  return { type: 'data', ...obj };
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

export interface AgentServerOptions {
  staticDir?: string; // Vite build output dir — serves SPA + assets
}

export function createAgentServer(streamFactory: StreamFactory, options: AgentServerOptions = {}): Application {
  const app = express();
  app.use(express.json());

  app.use((_req: Request, res: Response, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    next();
  });

  app.options('/chat', (_req: Request, res: Response) => { res.sendStatus(204); });

  app.post('/chat', async (req: Request, res: Response) => {
    const message = (req.body as { message?: string }).message?.trim();

    if (!message) {
      res.status(400).json({ error: '"message" is required' });
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');

    const controller = new AbortController();
    let closed = false;
    res.on('close', () => { closed = true; controller.abort(); });

    const send = (data: StreamItem): void => {
      if (!res.writableEnded && !closed) res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
      for await (const item of streamFactory(message, controller.signal)) {
        if (closed || res.writableEnded) break;
        const serialized = serializeItem(item);
        if (serialized['type'] === 'message' && serialized['role'] === 'user') continue;
        send(serialized);
      }
    } catch (err) {
      send({ type: 'error', error: err instanceof Error ? err.message : String(err) });
    } finally {
      send({ type: 'done' });
      if (!res.writableEnded) res.end();
    }
  });

  // Serve Vite build as SPA — must come AFTER the /chat route
  if (options.staticDir) {
    app.use(express.static(options.staticDir));
    app.get('/*path', (_req: Request, res: Response) => {
      res.sendFile(path.join(options.staticDir!, 'index.html'));
    });
  }

  return app;
}
