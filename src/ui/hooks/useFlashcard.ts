import { useCallback, useEffect, useState } from 'react';

export type FlashcardPhase = 'idle' | 'question' | 'answer' | 'done';

export interface FlashcardData {
  id: number;
  question: string;
  answer: string;
  topicLabel: string | null;
}

export function useFlashcard() {
  const [card, setCard] = useState<FlashcardData | null>(null);
  const [phase, setPhase] = useState<FlashcardPhase>('idle');

  useEffect(() => {
    fetch('/flashcard')
      .then(r => (r.ok ? r.json() : null))
      .then((data: FlashcardData | null) => {
        if (data?.id) {
          setCard(data);
          setPhase('question');
        }
      })
      .catch(() => {});
  }, []);

  const reveal = useCallback(() => {
    setPhase('answer');
  }, []);

  const submitScore = useCallback(
    async (score: string) => {
      if (!card) return;
      await fetch(`/flashcard/${card.id}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ score }),
      }).catch(() => {});
      setPhase('done');
    },
    [card],
  );

  return { card, phase, reveal, submitScore };
}
