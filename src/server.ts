import path from "path";
import { AgentServerOptions, FlashcardFilter } from "./types";
import express, { Application, Request, Response } from "express";

export type StreamItem = Record<string, unknown>;
export type StreamFactory = (
  userMessage: string,
  signal: AbortSignal,
) => AsyncGenerator<unknown>;

// ---------------------------------------------------------------------------
// Markdown detection — runs on the server to tag messages for the frontend
// ---------------------------------------------------------------------------

function isMarkdown(text: string): boolean {
  return (
    /^#{1,6}\s/m.test(text) || // headings
    /^\s*[-*+]\s/m.test(text) || // unordered list
    /^\s*\d+\.\s/m.test(text) || // ordered list
    /`[^`]+`/.test(text) || // inline code
    /^```/m.test(text) || // fenced code block
    /\*\*[^*]+\*\*/.test(text) || // bold
    /^>\s/m.test(text) // blockquote
  );
}

// ---------------------------------------------------------------------------
// SSE serialisation
// ---------------------------------------------------------------------------

export function serializeItem(item: unknown): StreamItem {
  if (item == null) return { type: "data" };
  const obj = item as Record<string, unknown>;

  if (obj["type"] === "token" && "content" in obj) {
    return {
      type: "token",
      content: obj["content"],
      source: obj["source"] ?? "assistant",
    };
  }
  if ("role" in obj && "content" in obj) {
    const content = String(obj["content"] ?? "");
    const contentType = isMarkdown(content) ? "markdown" : "text";
    return {
      type: "message",
      role: obj["role"],
      source: obj["source"] ?? "unknown",
      content,
      contentType,
    };
  }
  if ("finalResult" in obj) {
    return {
      type: "result",
      finalResult: obj["finalResult"],
      iterationsCompleted: obj["iterationsCompleted"],
    };
  }
  if ("type" in obj) {
    return { type: "event", event: obj["type"], data: obj["data"] };
  }
  return { type: "data", ...obj };
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

export function createAgentServer(
  streamFactory: StreamFactory,
  options: AgentServerOptions = {},
): Application {
  const app = express();
  app.use(express.json());

  app.use((_req: Request, res: Response, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    next();
  });

  app.options("/chat", (_req: Request, res: Response) => {
    res.sendStatus(204);
  });

  app.options("/history", (_req: Request, res: Response) => {
    res.sendStatus(204);
  });

  app.options("/flashcard", (_req: Request, res: Response) => {
    res.sendStatus(204);
  });

  app.options("/flashcard/:id/review", (_req: Request, res: Response) => {
    res.sendStatus(204);
  });

  app.options("/mindmap", (_req: Request, res: Response) => {
    res.sendStatus(204);
  });

  app.options("/topics", (_req: Request, res: Response) => {
    res.sendStatus(204);
  });

  app.post("/chat", async (req: Request, res: Response) => {
    const message = (req.body as { message?: string }).message?.trim();

    if (!message) {
      res.status(400).json({ error: '"message" is required' });
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(": connected\n\n");

    const controller = new AbortController();
    let closed = false;
    res.on("close", () => {
      closed = true;
      controller.abort();
    });

    const send = (data: StreamItem): void => {
      if (!res.writableEnded && !closed)
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
      for await (const item of streamFactory(message, controller.signal)) {
        if (closed || res.writableEnded) break;
        const serialized = serializeItem(item);
        if (serialized["type"] === "message" && serialized["role"] === "user")
          continue;
        send(serialized);
      }
    } catch (err) {
      send({
        type: "error",
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      send({ type: "done" });
      if (!res.writableEnded) res.end();
    }
  });

  app.get("/history", async (req: Request, res: Response) => {
    if (!options.getHistory) {
      res.status(404).json({ error: "History not configured" });
      return;
    }
    const limitParam = parseInt(
      String((req.query as Record<string, string>)["limit"] ?? "50"),
      10,
    );
    const limit = Math.min(
      Math.max(1, isNaN(limitParam) ? 50 : limitParam),
      100,
    );
    try {
      const messages = await options.getHistory(limit);
      res.json(messages);
    } catch (err) {
      res
        .status(500)
        .json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/flashcard", async (_req: Request, res: Response) => {
    if (!options.flashcardAgent) {
      res.status(404).json({ error: "Flashcard not configured" });
      return;
    }
    try {
      const card = await options.flashcardAgent.selectForReview();
      res.json(card ?? null);
    } catch (err) {
      res
        .status(500)
        .json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/flashcard", async (req: Request, res: Response) => {
    if (!options.flashcardAgent) {
      res.status(404).json({ error: "Flashcard not configured" });
      return;
    }
    const body = req.body as { topicIds?: unknown; subtopics?: unknown };
    const filter: FlashcardFilter = {
      topicIds: Array.isArray(body.topicIds)
        ? (body.topicIds as number[]).filter((x) => typeof x === "number")
        : undefined,
      subtopics: Array.isArray(body.subtopics)
        ? (body.subtopics as Array<{ topicId: number; subtopic: string }>).filter(
            (x) => typeof x.topicId === "number" && typeof x.subtopic === "string",
          )
        : undefined,
    };
    try {
      const card = await options.flashcardAgent.selectForReview(filter);
      res.json(card ?? null);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/flashcard/:id/review", async (req: Request, res: Response) => {
    if (!options.flashcardAgent) {
      res.status(404).json({ error: "Flashcard not configured" });
      return;
    }
    const id = parseInt(
      String((req.params as Record<string, string>)["id"]),
      10,
    );
    const score = (req.body as { score?: string }).score?.trim();
    if (!score || !["very_easy", "easy", "hard", "fail"].includes(score)) {
      res
        .status(400)
        .json({ error: "score must be one of: very_easy, easy, hard, fail" });
      return;
    }
    try {
      const nextDueAt = await options.flashcardAgent.applyReview(id, score);
      res.json({ nextDueAt });
    } catch (err) {
      res
        .status(500)
        .json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/mindmap", async (_req: Request, res: Response) => {
    if (!options.getMindmap) {
      res.status(404).json({ error: "Mindmap not configured" });
      return;
    }
    try {
      res.json(await options.getMindmap());
    } catch (err) {
      res
        .status(500)
        .json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/topics", async (_req: Request, res: Response) => {
    if (!options.getTopics) {
      res.status(404).json({ error: "Topics not configured" });
      return;
    }
    try {
      res.json(await options.getTopics());
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Serve Vite build as SPA — must come AFTER the /chat route
  if (options.staticDir) {
    app.use(express.static(options.staticDir));
    app.get("/*path", (_req: Request, res: Response) => {
      res.sendFile(path.join(options.staticDir!, "index.html"));
    });
  }

  return app;
}
