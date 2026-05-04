import pg from 'pg';

export interface Sm2State {
  intervalDays: number;
  easeFactor: number;
  repetitions: number;
}

export interface DueCard {
  id: number;
  question: string;
  topicLabel: string | null;
  lastScore: string | null;
  daysOverdue: number;
}

export interface FlashcardCard {
  id: number;
  question: string;
  answer: string;
  topicLabel: string | null;
}

const SCORE_TO_QUALITY: Record<string, number> = {
  fail: 0,
  hard: 2,
  easy: 4,
  very_easy: 5,
};

export function applySm2(state: Sm2State, quality: number): Sm2State & { nextDueAt: Date } {
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

export class FlashcardService {
  constructor(private pool: pg.Pool) {}

  async getDueCards(limit = 10): Promise<DueCard[]> {
    const { rows } = await this.pool.query<{
      id: number;
      question: string;
      topic_label: string | null;
      last_score: string | null;
      next_due_at: string;
    }>(
      `SELECT f.id, f.question, f.topic_label, f.next_due_at,
              r.score AS last_score
       FROM flashcards f
       LEFT JOIN LATERAL (
         SELECT score FROM flashcard_reviews
         WHERE flashcard_id = f.id
         ORDER BY reviewed_at DESC
         LIMIT 1
       ) r ON true
       WHERE f.next_due_at <= now() OR f.repetitions = 0
       ORDER BY f.next_due_at ASC, f.repetitions ASC
       LIMIT $1`,
      [limit],
    );

    return rows.map(r => ({
      id: r.id,
      question: r.question,
      topicLabel: r.topic_label,
      lastScore: r.last_score,
      daysOverdue: Math.max(
        0,
        Math.floor((Date.now() - new Date(r.next_due_at).getTime()) / (1000 * 60 * 60 * 24)),
      ),
    }));
  }

  async applyReview(id: number, score: string): Promise<Date> {
    const quality = SCORE_TO_QUALITY[score];
    if (quality === undefined) throw new Error(`Invalid score: ${score}`);

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const { rows } = await client.query<{
        interval_days: number;
        ease_factor: number;
        repetitions: number;
      }>('SELECT interval_days, ease_factor, repetitions FROM flashcards WHERE id = $1', [id]);

      if (!rows[0]) throw new Error(`Flashcard ${id} not found`);

      const next = applySm2(
        { intervalDays: rows[0].interval_days, easeFactor: rows[0].ease_factor, repetitions: rows[0].repetitions },
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
        'INSERT INTO flashcard_reviews (flashcard_id, score, sm2_quality) VALUES ($1, $2, $3)',
        [id, score, quality],
      );

      await client.query('COMMIT');
      return next.nextDueAt;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async getById(id: number): Promise<FlashcardCard | null> {
    const { rows } = await this.pool.query<{
      id: number;
      question: string;
      answer: string;
      topic_label: string | null;
    }>('SELECT id, question, answer, topic_label FROM flashcards WHERE id = $1', [id]);

    if (!rows[0]) return null;
    return {
      id: rows[0].id,
      question: rows[0].question,
      answer: rows[0].answer,
      topicLabel: rows[0].topic_label,
    };
  }
}
