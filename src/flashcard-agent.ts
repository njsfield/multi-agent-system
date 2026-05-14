import pg from "pg";
import { OpenAIAgent } from "./openai-agent";
import { FunctionTool } from "./tool";
import { OtelMiddleware } from "./otel-middleware";
import type { FlashcardCard, DueCard } from "./types";

// ---------------------------------------------------------------------------
// SM-2 spaced-repetition algorithm
// ---------------------------------------------------------------------------

interface Sm2State {
  intervalDays: number;
  easeFactor: number;
  repetitions: number;
}

const SCORE_TO_QUALITY: Record<string, number> = {
  fail: 0,
  hard: 2,
  easy: 4,
  very_easy: 5,
};

function applySm2(state: Sm2State, quality: number): Sm2State & { nextDueAt: Date } {
  let { intervalDays, easeFactor, repetitions } = state;

  if (quality < 3) {
    repetitions = 0;
    intervalDays = 1;
  } else {
    if (repetitions === 0) intervalDays = 1;
    else if (repetitions === 1) intervalDays = 6;
    else intervalDays = Math.round(intervalDays * easeFactor);
    repetitions++;
  }

  easeFactor += 0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02);
  easeFactor = Math.max(1.3, easeFactor);

  const nextDueAt = new Date();
  nextDueAt.setDate(nextDueAt.getDate() + intervalDays);

  return { intervalDays, easeFactor, repetitions, nextDueAt };
}

// ---------------------------------------------------------------------------
// Agent instructions
// ---------------------------------------------------------------------------

export const SELECTION_INSTRUCTIONS = `You are a spaced repetition tutor. Select the single best flashcard for the user to review right now.

Call get_due_flashcards to see available cards. Prioritise:
1. Cards with lastScore "fail" or "hard" that are overdue (daysOverdue > 0)
2. Cards never reviewed (lastScore null)
3. Cards most overdue

Prefer topic variety. Call select_card with the chosen id, or id=null if none available.`;

export const EXTRACTION_INSTRUCTIONS = `You are a flashcard extractor for spaced repetition learning.

Given a conversation exchange, decide if it contains a clear factual Q&A worth memorising.

Steps:
1. If the exchange contains a learnable fact, call get_flashcards_by_topic to check for duplicates.
2. If no duplicate exists, call save_flashcard with a concise question and direct answer.
3. If the exchange is casual chat, task help, or contains no clear fact, do nothing.`;

// ---------------------------------------------------------------------------
// Tool factories
// ---------------------------------------------------------------------------

function buildSelectionTools(
  pool: pg.Pool,
  state: { selectedId: number | null },
): FunctionTool[] {
  const getDueFlashcards = new FunctionTool(
    async (params) => {
      const limit = Math.min(Number(params["limit"] ?? 10), 20);
      const topicId = params["topic_id"] != null ? Number(params["topic_id"]) : undefined;

      const args: unknown[] = [limit];
      const topicClause =
        topicId !== undefined ? ` AND f.topic_id = $${args.push(topicId)}` : "";

      try {
        const { rows } = await pool.query<{
          id: number;
          question: string;
          topic_id: number | null;
          topic_label: string | null;
          last_score: string | null;
          next_due_at: string;
        }>(
          `SELECT f.id, f.question, f.topic_id, t.label AS topic_label, f.next_due_at,
                  r.score AS last_score
           FROM flashcards f
           LEFT JOIN topics t ON f.topic_id = t.id
           LEFT JOIN LATERAL (
             SELECT score FROM flashcard_reviews
             WHERE flashcard_id = f.id
             ORDER BY reviewed_at DESC LIMIT 1
           ) r ON true
           WHERE (f.next_due_at <= now() OR f.repetitions = 0)${topicClause}
           ORDER BY f.next_due_at ASC, f.repetitions ASC
           LIMIT $1`,
          args,
        );

        const cards: DueCard[] = rows.map((r) => ({
          id: r.id,
          question: r.question,
          topicId: r.topic_id,
          topicLabel: r.topic_label,
          lastScore: r.last_score,
          daysOverdue: Math.max(
            0,
            Math.floor((Date.now() - new Date(r.next_due_at).getTime()) / 86_400_000),
          ),
        }));

        return JSON.stringify(cards);
      } catch (err) {
        return JSON.stringify({ error: String(err) });
      }
    },
    "get_due_flashcards",
    "Get flashcards due for review. Returns [{id, question, topicId, topicLabel, lastScore, daysOverdue}].",
    {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max cards to return (default 10)" },
        topic_id: { type: "number", description: "Optional: filter by topic" },
      },
      required: [],
    },
  );

  const selectCard = new FunctionTool(
    (params) => {
      const raw = params["id"];
      state.selectedId = raw != null && raw !== "null" ? Number(raw) : null;
      return JSON.stringify({ success: true });
    },
    "select_card",
    "Record the chosen flashcard ID for review. Pass id=null if no cards are available.",
    {
      type: "object",
      properties: {
        id: { description: "Flashcard ID to review, or null if none available" },
      },
      required: ["id"],
    },
  );

  return [getDueFlashcards, selectCard];
}

function buildExtractionTools(pool: pg.Pool): FunctionTool[] {
  const getFlashcardsByTopic = new FunctionTool(
    async (params) => {
      const topicId = params["topic_id"] != null ? Number(params["topic_id"]) : null;
      try {
        const { rows } = await pool.query<{ id: number; question: string }>(
          topicId != null
            ? `SELECT id, question FROM flashcards WHERE topic_id = $1 ORDER BY id DESC LIMIT 20`
            : `SELECT id, question FROM flashcards ORDER BY id DESC LIMIT 20`,
          topicId != null ? [topicId] : [],
        );
        return JSON.stringify(rows);
      } catch (err) {
        return JSON.stringify({ error: String(err) });
      }
    },
    "get_flashcards_by_topic",
    "Fetch existing flashcards (id, question) to check for duplicates before saving.",
    {
      type: "object",
      properties: {
        topic_id: { type: "number", description: "Optional topic filter" },
      },
      required: [],
    },
  );

  const saveFlashcard = new FunctionTool(
    async (params) => {
      const question = String(params["question"] ?? "").trim();
      const answer = String(params["answer"] ?? "").trim();
      const topicId = params["topic_id"] != null ? Number(params["topic_id"]) : null;

      if (!question || !answer) {
        return JSON.stringify({ error: "question and answer required" });
      }

      try {
        await pool.query(
          `INSERT INTO flashcards (question, answer, topic_id) VALUES ($1, $2, $3)`,
          [question, answer, topicId],
        );
        return JSON.stringify({ saved: true });
      } catch (err) {
        return JSON.stringify({ error: String(err) });
      }
    },
    "save_flashcard",
    "Persist a new flashcard to the database.",
    {
      type: "object",
      properties: {
        question: { type: "string", description: "Concise question" },
        answer: { type: "string", description: "Direct factual answer" },
        topic_id: { type: "number", description: "Optional topic ID" },
      },
      required: ["question", "answer"],
    },
  );

  return [getFlashcardsByTopic, saveFlashcard];
}

// ---------------------------------------------------------------------------
// FlashcardAgent
// ---------------------------------------------------------------------------

export class FlashcardAgent extends OpenAIAgent {
  private _pool: pg.Pool;
  private _state: { selectedId: number | null };

  constructor(pool: pg.Pool) {
    const state = { selectedId: null as number | null };

    super("flashcard-agent", SELECTION_INSTRUCTIONS, {
      tools: [...buildSelectionTools(pool, state), ...buildExtractionTools(pool)],
      middleware: [new OtelMiddleware("flashcard-agent")],
      streamTokens: false,
    });

    this._pool = pool;
    this._state = state;
  }

  async selectForReview(topicId?: number): Promise<FlashcardCard | null> {
    this.context.messages = [];
    this.instructions = SELECTION_INSTRUCTIONS;
    this._state.selectedId = null;

    const prompt =
      topicId !== undefined
        ? `Select a flashcard for review from topic_id ${topicId}. Call get_due_flashcards with topic_id=${topicId}, then select_card.`
        : `Select a flashcard for review. Call get_due_flashcards, then select_card.`;

    await this.run(prompt);

    if (this._state.selectedId === null) return null;
    return this._fetchById(this._state.selectedId);
  }

  async extract(userMsg: string, assistantMsg: string): Promise<void> {
    if (!assistantMsg.trim()) return;
    this.context.messages = [];
    this.instructions = EXTRACTION_INSTRUCTIONS;
    await this.run(
      `Extract a flashcard from this exchange:\n\nUser: "${userMsg}"\nAssistant: "${assistantMsg}"`,
    );
  }

  async applyReview(id: number, score: string): Promise<Date> {
    const quality = SCORE_TO_QUALITY[score];
    if (quality === undefined) throw new Error(`Invalid score: ${score}`);

    const client = await this._pool.connect();
    try {
      await client.query("BEGIN");

      const { rows } = await client.query<{
        interval_days: number;
        ease_factor: number;
        repetitions: number;
      }>(
        "SELECT interval_days, ease_factor, repetitions FROM flashcards WHERE id = $1",
        [id],
      );

      if (!rows[0]) throw new Error(`Flashcard ${id} not found`);

      const next = applySm2(
        {
          intervalDays: rows[0].interval_days,
          easeFactor: rows[0].ease_factor,
          repetitions: rows[0].repetitions,
        },
        quality,
      );

      await client.query(
        `UPDATE flashcards
         SET interval_days = $1, ease_factor = $2, repetitions = $3,
             next_due_at = $4, last_reviewed_at = now()
         WHERE id = $5`,
        [next.intervalDays, next.easeFactor, next.repetitions, next.nextDueAt, id],
      );

      await client.query(
        "INSERT INTO flashcard_reviews (flashcard_id, score, sm2_quality) VALUES ($1, $2, $3)",
        [id, score, quality],
      );

      await client.query("COMMIT");
      return next.nextDueAt;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  private async _fetchById(id: number): Promise<FlashcardCard | null> {
    const { rows } = await this._pool.query<{
      id: number;
      question: string;
      answer: string;
      topic_id: number | null;
      topic_label: string | null;
      subtopic: string | null;
    }>(
      `SELECT f.id, f.question, f.answer, f.topic_id, t.label AS topic_label, f.subtopic
       FROM flashcards f
       LEFT JOIN topics t ON f.topic_id = t.id
       WHERE f.id = $1`,
      [id],
    );
    if (!rows[0]) return null;
    const r = rows[0];
    return {
      id: r.id,
      question: r.question,
      answer: r.answer,
      topicId: r.topic_id,
      topicLabel: r.topic_label,
      subtopic: r.subtopic ?? null,
    };
  }
}
