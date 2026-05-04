import { describe, it, expect, vi } from 'vitest';
import { applySm2, FlashcardService } from './flashcard-service';
import type pg from 'pg';

// ── applySm2 ────────────────────────────────────────────────────────────────

describe('applySm2', () => {
  it('fail (quality 0) resets repetitions to 0 and sets interval to 1', () => {
    const result = applySm2({ intervalDays: 6, easeFactor: 2.5, repetitions: 2 }, 0);
    expect(result.repetitions).toBe(0);
    expect(result.intervalDays).toBe(1);
  });

  it('hard (quality 2) also resets repetitions', () => {
    const result = applySm2({ intervalDays: 6, easeFactor: 2.5, repetitions: 2 }, 2);
    expect(result.repetitions).toBe(0);
    expect(result.intervalDays).toBe(1);
  });

  it('easy (quality 4) on first review sets interval to 1 and increments repetitions', () => {
    const result = applySm2({ intervalDays: 1, easeFactor: 2.5, repetitions: 0 }, 4);
    expect(result.intervalDays).toBe(1);
    expect(result.repetitions).toBe(1);
  });

  it('easy on second review sets interval to 6', () => {
    const result = applySm2({ intervalDays: 1, easeFactor: 2.5, repetitions: 1 }, 4);
    expect(result.intervalDays).toBe(6);
    expect(result.repetitions).toBe(2);
  });

  it('easy on third review multiplies interval by ease_factor', () => {
    const result = applySm2({ intervalDays: 6, easeFactor: 2.5, repetitions: 2 }, 4);
    expect(result.intervalDays).toBe(15); // round(6 * 2.5)
    expect(result.repetitions).toBe(3);
  });

  it('very_easy (quality 5) increases ease_factor above 2.5', () => {
    const result = applySm2({ intervalDays: 1, easeFactor: 2.5, repetitions: 0 }, 5);
    expect(result.easeFactor).toBeGreaterThan(2.5);
  });

  it('repeated fails floor ease_factor at 1.3', () => {
    const result = applySm2({ intervalDays: 1, easeFactor: 1.3, repetitions: 0 }, 0);
    expect(result.easeFactor).toBeCloseTo(1.3);
  });

  it('nextDueAt is approximately intervalDays from now', () => {
    const result = applySm2({ intervalDays: 6, easeFactor: 2.5, repetitions: 2 }, 4);
    const expectedMs = result.intervalDays * 24 * 60 * 60 * 1000;
    const actualMs = result.nextDueAt.getTime() - Date.now();
    expect(actualMs).toBeGreaterThan(expectedMs - 5000);
    expect(actualMs).toBeLessThan(expectedMs + 5000);
  });
});

// ── FlashcardService ────────────────────────────────────────────────────────

function makePool(queryImpl: ReturnType<typeof vi.fn> = vi.fn()) {
  return { query: queryImpl } as unknown as pg.Pool;
}

describe('FlashcardService', () => {
  describe('getDueCards', () => {
    it('returns mapped DueCard objects from query results', async () => {
      const pastDue = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
      const query = vi.fn().mockResolvedValue({
        rows: [{
          id: 1,
          question: 'What is the capital of France?',
          topic_label: 'Geography',
          last_score: 'hard',
          interval_days: 1,
          next_due_at: pastDue,
        }],
      });
      const service = new FlashcardService(makePool(query));
      const cards = await service.getDueCards(10);

      expect(cards).toHaveLength(1);
      expect(cards[0]).toMatchObject({
        id: 1,
        question: 'What is the capital of France?',
        topicLabel: 'Geography',
        lastScore: 'hard',
      });
      expect(cards[0]!.daysOverdue).toBeGreaterThanOrEqual(1);
    });
  });

  describe('applyReview', () => {
    it('updates flashcard SM-2 state and inserts a review record', async () => {
      const query = vi.fn()
        .mockResolvedValueOnce({ rows: [{ interval_days: 1, ease_factor: 2.5, repetitions: 0 }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });
      const service = new FlashcardService(makePool(query));

      await service.applyReview(1, 'easy');

      expect(query).toHaveBeenCalledTimes(3);
      expect(String(query.mock.calls[1]![0])).toMatch(/UPDATE flashcards/);
      expect(String(query.mock.calls[2]![0])).toMatch(/INSERT INTO flashcard_reviews/);
    });

    it('throws for unknown score', async () => {
      const service = new FlashcardService(makePool());
      await expect(service.applyReview(1, 'oops')).rejects.toThrow('Invalid score: oops');
    });
  });

  describe('getById', () => {
    it('returns card with answer when found', async () => {
      const query = vi.fn().mockResolvedValue({
        rows: [{ id: 1, question: 'Q?', answer: 'A!', topic_label: 'Topic' }],
      });
      const service = new FlashcardService(makePool(query));
      const card = await service.getById(1);
      expect(card).toEqual({ id: 1, question: 'Q?', answer: 'A!', topicLabel: 'Topic' });
    });

    it('returns null when not found', async () => {
      const query = vi.fn().mockResolvedValue({ rows: [] });
      const service = new FlashcardService(makePool(query));
      expect(await service.getById(999)).toBeNull();
    });
  });
});
