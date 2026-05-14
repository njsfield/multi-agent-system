import pg from "pg";
import { OpenAIAgent } from "./openai-agent";
import { FunctionTool } from "./tool";
import { OtelMiddleware } from "./otel-middleware";
import type { FlashcardCard, DueCard, FlashcardFilter, TopicTree } from "./types";

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

Given a conversation exchange, extract up to 5 distinct, independently learnable facts as flashcards.

Rules:
- Only extract clear factual claims that are worth memorising.
- Each flashcard must cover a DIFFERENT fact — do not rephrase the same concept twice.
- If the exchange is casual chat, a task request, or contains no clear facts, call save_flashcards with an empty array.
- Questions must be specific and answerable. Answers must be concise and direct.

Steps:
1. Identify all distinct learnable facts in the exchange (max 5).
2. Call save_flashcards with the array of {question, answer} pairs (empty array if none).`;

// ---------------------------------------------------------------------------
// Tool factories
// ---------------------------------------------------------------------------

function buildSelectionTools(
  pool: pg.Pool,
  state: { selectedId: number | null },
  filterRef: { current: FlashcardFilter | undefined },
): FunctionTool[] {
  const getDueFlashcards = new FunctionTool(
    async (params) => {
      const limit = Math.min(Number(params["limit"] ?? 10), 20);
      const filter = filterRef.current;

      const args: unknown[] = [limit];
      const parts: string[] = [];

      if (filter?.topicIds && filter.topicIds.length > 0) {
        parts.push(`f.topic_id = ANY($${args.push(filter.topicIds)}::int[])`);
      }
      if (filter?.subtopics && filter.subtopics.length > 0) {
        for (const { topicId, subtopic } of filter.subtopics) {
          parts.push(`(f.topic_id = $${args.push(topicId)} AND f.subtopic = $${args.push(subtopic)})`);
        }
      }

      const filterClause = parts.length > 0 ? `AND (${parts.join(" OR ")})` : "";

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
           WHERE (f.next_due_at <= now() OR f.repetitions = 0)
           ${filterClause}
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

function buildExtractionTools(
  pool: pg.Pool,
  state: { savedCards: Array<{ question: string; answer: string }> },
): FunctionTool[] {
  const saveFlashcards = new FunctionTool(
    async (params) => {
      const raw = params["flashcards"];
      if (!Array.isArray(raw) || raw.length === 0) {
        state.savedCards = [];
        return JSON.stringify({ saved: 0 });
      }

      const cards = (raw as Array<{ question?: string; answer?: string }>)
        .filter((c) => c.question?.trim() && c.answer?.trim())
        .slice(0, 5);

      state.savedCards = cards.map((c) => ({
        question: c.question!.trim(),
        answer: c.answer!.trim(),
      }));

      return JSON.stringify({ saved: cards.length });
    },
    "save_flashcards",
    "Save an array of flashcard {question, answer} pairs extracted from the exchange. Pass an empty array if no facts found.",
    {
      type: "object",
      properties: {
        flashcards: {
          type: "array",
          description: "Array of {question, answer} objects, max 5",
          items: {
            type: "object",
            properties: {
              question: { type: "string" },
              answer: { type: "string" },
            },
            required: ["question", "answer"],
          },
        },
      },
      required: ["flashcards"],
    },
  );

  return [saveFlashcards];
}

// ---------------------------------------------------------------------------
// FlashcardAgent
// ---------------------------------------------------------------------------

export class FlashcardAgent extends OpenAIAgent {
  private _pool: pg.Pool;
  private _state: { selectedId: number | null };
  private _extractState: { savedCards: Array<{ question: string; answer: string }> };
  private _filterRef: { current: FlashcardFilter | undefined };

  constructor(pool: pg.Pool) {
    const state = { selectedId: null as number | null };
    const extractState = { savedCards: [] as Array<{ question: string; answer: string }> };
    const filterRef = { current: undefined as FlashcardFilter | undefined };

    super("flashcard-agent", SELECTION_INSTRUCTIONS, {
      tools: [
        ...buildSelectionTools(pool, state, filterRef),
        ...buildExtractionTools(pool, extractState),
      ],
      middleware: [new OtelMiddleware("flashcard-agent")],
      streamTokens: false,
    });

    this._pool = pool;
    this._state = state;
    this._extractState = extractState;
    this._filterRef = filterRef;
  }

  async selectForReview(filter?: FlashcardFilter): Promise<FlashcardCard | null> {
    this._filterRef.current = filter;
    this.context.messages = [];
    this.instructions = SELECTION_INSTRUCTIONS;
    this._state.selectedId = null;

    const hasFilter =
      (filter?.topicIds?.length ?? 0) > 0 ||
      (filter?.subtopics?.length ?? 0) > 0;

    const prompt = hasFilter
      ? `Select a flashcard for review using the active topic filter. Call get_due_flashcards, then select_card.`
      : `Select a flashcard for review. Call get_due_flashcards, then select_card.`;

    await this.run(prompt);
    this._filterRef.current = undefined;

    if (this._state.selectedId === null) return null;
    return this._fetchById(this._state.selectedId);
  }

  async getTopicsWithSubtopics(): Promise<TopicTree[]> {
    const { rows } = await this._pool.query<{
      id: number;
      label: string;
      subtopics: string[] | null;
    }>(
      `SELECT t.id, t.label,
         array_agg(DISTINCT f.subtopic) FILTER (WHERE f.subtopic IS NOT NULL) AS subtopics
       FROM topics t
       JOIN flashcards f ON f.topic_id = t.id
       GROUP BY t.id, t.label
       ORDER BY t.label`,
    );
    return rows.map((r) => ({
      id: r.id,
      label: r.label,
      subtopics: r.subtopics ?? [],
    }));
  }

  async extract(userMsg: string, assistantMsg: string, sourceMessageId?: number): Promise<void> {
    if (!assistantMsg.trim()) return;

    // Fetch subtopic from source message if we have its id
    let subtopic: string | null = null;
    let topicId: number | null = null;
    if (sourceMessageId != null) {
      const { rows } = await this._pool.query<{ topic_id: number | null; subtopic: string | null }>(
        'SELECT topic_id, subtopic FROM messages WHERE id = $1',
        [sourceMessageId],
      );
      if (rows[0]) {
        topicId = rows[0].topic_id;
        subtopic = rows[0].subtopic;
      }
    }

    this._extractState.savedCards = [];
    this.context.messages = [];
    this.instructions = EXTRACTION_INSTRUCTIONS;

    await this.run(
      `Extract flashcards from this exchange:\n\nUser: "${userMsg}"\nAssistant: "${assistantMsg}"`,
    );

    // Persist each candidate independently, checking for duplicates
    for (const card of this._extractState.savedCards) {
      const isDup = await this._isDuplicate(card.question);
      if (!isDup) {
        await this._pool.query(
          `INSERT INTO flashcards (question, answer, topic_id, subtopic, source_message_id)
           VALUES ($1, $2, $3, $4, $5)`,
          [card.question, card.answer, topicId, subtopic, sourceMessageId ?? null],
        );
      }
    }
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

  private async _isDuplicate(question: string): Promise<boolean> {
    const { rows } = await this._pool.query<{ id: number }>(
      `SELECT id FROM flashcards WHERE lower(trim(question)) = lower(trim($1)) LIMIT 1`,
      [question],
    );
    return rows.length > 0;
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
