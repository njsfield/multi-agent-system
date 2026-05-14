import { BookOpen } from "lucide-react";
import { Button } from "@/components/ui/button";

interface Props {
  onClick: () => void;
  disabled: boolean;
}

export function FlashcardButton({ onClick, disabled }: Props) {
  return (
    <Button
      type="button"
      size="icon"
      variant="outline"
      onClick={onClick}
      disabled={disabled}
      title={disabled ? "Finish current card first" : "Get a flashcard"}
    >
      <BookOpen className="h-4 w-4" />
    </Button>
  );
}
