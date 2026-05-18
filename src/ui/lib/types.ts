export interface TopicTree {
  id: number;
  label: string;
  parentId: number | null;
  children: { id: number; label: string }[];
}

export interface FlashcardFilter {
  topicIds?: number[];
}
