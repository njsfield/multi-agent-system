export interface TopicTree {
  id: number;
  label: string;
  subtopics: string[];
}

export interface FlashcardFilter {
  topicIds?: number[];
  subtopics?: Array<{ topicId: number; subtopic: string }>;
}
