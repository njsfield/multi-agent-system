import type { FlashcardData, FlashcardPhase } from '@/hooks/useFlashcard';

interface Props {
  card: FlashcardData;
  phase: FlashcardPhase;
  onReveal: () => void;
  onScore: (score: string) => void;
}

const SCORE_BUTTONS = [
  { score: 'fail',      label: 'Fail',      className: 'bg-red-500 hover:bg-red-600 text-white' },
  { score: 'hard',      label: 'Hard',      className: 'bg-amber-500 hover:bg-amber-600 text-white' },
  { score: 'easy',      label: 'Easy',      className: 'bg-green-500 hover:bg-green-600 text-white' },
  { score: 'very_easy', label: 'Very Easy', className: 'bg-teal-500 hover:bg-teal-600 text-white' },
] as const;

export function FlashcardWidget({ card, phase, onReveal, onScore }: Props) {
  if (phase === 'idle') return null;

  if (phase === 'done') {
    return (
      <div className="rounded-lg border border-border bg-muted/30 px-4 py-2 text-center text-sm text-muted-foreground">
        Review logged. See you next time!
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-card p-4 shadow-sm">
      {card.topicLabel && (
        <span className="mb-2 inline-block rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
          {card.topicLabel}
        </span>
      )}
      <p className="text-sm font-medium text-foreground">{card.question}</p>

      {phase === 'question' && (
        <button
          onClick={onReveal}
          className="mt-3 rounded-md bg-secondary px-4 py-1.5 text-sm font-medium text-secondary-foreground hover:bg-secondary/80"
        >
          Reveal Answer
        </button>
      )}

      {phase === 'answer' && (
        <>
          <hr className="my-3 border-border" />
          <p className="text-sm text-muted-foreground">{card.answer}</p>
          <div className="mt-3 flex gap-2">
            {SCORE_BUTTONS.map(({ score, label, className }) => (
              <button
                key={score}
                onClick={() => onScore(score)}
                className={`rounded-md px-3 py-1.5 text-xs font-medium ${className}`}
              >
                {label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
