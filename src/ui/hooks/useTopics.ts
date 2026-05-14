import { useEffect, useState } from "react";
import type { TopicTree } from "@/lib/types";

export function useTopics(): { topics: TopicTree[]; loading: boolean } {
  const [topics, setTopics] = useState<TopicTree[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/topics")
      .then((r) => (r.ok ? r.json() : Promise.resolve([])))
      .then((data: TopicTree[]) => setTopics(data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return { topics, loading };
}
