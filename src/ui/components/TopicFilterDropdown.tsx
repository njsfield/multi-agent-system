import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { TopicTree, FlashcardFilter } from "@/lib/types";

interface Props {
  topics: TopicTree[];
  filter: FlashcardFilter;
  onChange: (filter: FlashcardFilter) => void;
}

export function TopicFilterDropdown({ topics, filter, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const selectedCount =
    (filter.topicIds?.length ?? 0) + (filter.subtopics?.length ?? 0);

  const isTopicSelected = (id: number) =>
    filter.topicIds?.includes(id) ?? false;

  const isSubtopicSelected = (topicId: number, subtopic: string) =>
    filter.subtopics?.some((s) => s.topicId === topicId && s.subtopic === subtopic) ?? false;

  const toggleTopic = (id: number) => {
    const topicIds = filter.topicIds ?? [];
    const next = topicIds.includes(id)
      ? topicIds.filter((x) => x !== id)
      : [...topicIds, id];
    onChange({ ...filter, topicIds: next.length > 0 ? next : undefined });
  };

  const toggleSubtopic = (topicId: number, subtopic: string) => {
    const subs = filter.subtopics ?? [];
    const exists = subs.some((s) => s.topicId === topicId && s.subtopic === subtopic);
    const next = exists
      ? subs.filter((s) => !(s.topicId === topicId && s.subtopic === subtopic))
      : [...subs, { topicId, subtopic }];
    onChange({ ...filter, subtopics: next.length > 0 ? next : undefined });
  };

  const clearAll = () => onChange({});

  const toggleExpand = (id: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Filter by topic"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          padding: "6px 10px",
          borderRadius: 6,
          border: "1px solid var(--border)",
          background: selectedCount > 0 ? "var(--primary)" : "var(--background)",
          color: selectedCount > 0 ? "var(--primary-foreground)" : "var(--muted-foreground)",
          fontSize: 12,
          cursor: "pointer",
          whiteSpace: "nowrap",
        }}
      >
        Topics
        {selectedCount > 0 && (
          <span
            style={{
              background: "var(--primary-foreground)",
              color: "var(--primary)",
              borderRadius: 99,
              padding: "0 5px",
              fontSize: 10,
              fontWeight: 700,
            }}
          >
            {selectedCount}
          </span>
        )}
      </button>

      {open && (
        <div
          style={{
            position: "absolute",
            bottom: "calc(100% + 6px)",
            left: 0,
            width: 240,
            maxHeight: 320,
            overflowY: "auto",
            background: "var(--card)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            padding: "8px 0",
            zIndex: 50,
            boxShadow: "0 4px 16px rgba(0,0,0,0.3)",
          }}
        >
          {selectedCount > 0 && (
            <div style={{ padding: "0 12px 6px", borderBottom: "1px solid var(--border)", marginBottom: 4 }}>
              <button
                type="button"
                onClick={clearAll}
                style={{ fontSize: 11, color: "var(--muted-foreground)", cursor: "pointer", background: "none", border: "none" }}
              >
                Clear all
              </button>
            </div>
          )}
          {topics.length === 0 && (
            <p style={{ padding: "8px 12px", fontSize: 12, color: "var(--muted-foreground)" }}>
              No topics yet
            </p>
          )}
          {topics.map((topic) => (
            <div key={topic.id}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "4px 12px",
                  cursor: "pointer",
                }}
              >
                {topic.subtopics.length > 0 && (
                  <button
                    type="button"
                    onClick={() => toggleExpand(topic.id)}
                    style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: "var(--muted-foreground)", display: "flex" }}
                  >
                    {expanded.has(topic.id) ? (
                      <ChevronDown className="h-3 w-3" />
                    ) : (
                      <ChevronRight className="h-3 w-3" />
                    )}
                  </button>
                )}
                {topic.subtopics.length === 0 && <span style={{ width: 12 }} />}
                <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 13, color: "var(--foreground)", userSelect: "none", flex: 1 }}>
                  <input
                    type="checkbox"
                    checked={isTopicSelected(topic.id)}
                    onChange={() => toggleTopic(topic.id)}
                    style={{ cursor: "pointer" }}
                  />
                  {topic.label}
                </label>
              </div>
              {expanded.has(topic.id) && topic.subtopics.map((sub) => (
                <label
                  key={sub}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "3px 12px 3px 32px",
                    cursor: "pointer",
                    fontSize: 12,
                    color: "var(--muted-foreground)",
                    userSelect: "none",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={isSubtopicSelected(topic.id, sub)}
                    onChange={() => toggleSubtopic(topic.id, sub)}
                    style={{ cursor: "pointer" }}
                  />
                  {sub}
                </label>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
