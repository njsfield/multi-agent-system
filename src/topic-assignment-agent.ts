import pg from "pg";
import OpenAI from "openai";

interface AssignmentEntry {
  flashcardId: number;
  topicId?: number;
  newTopicLabel?: string;
}

interface SplitGroup {
  label: string;
  flashcardIds: number[];
}

export class TopicAssignmentAgent {
  constructor(
    private pool: pg.Pool,
    private openai: OpenAI,
  ) {}

  async assignTopics(
    flashcardIds: number[],
    opts: { skipAutoSplit?: boolean } = {},
  ): Promise<void> {
    if (flashcardIds.length === 0) return;

    const { rows: cards } = await this.pool.query<{
      id: number;
      question: string;
      answer: string;
    }>(
      "SELECT id, question, answer FROM flashcards WHERE id = ANY($1)",
      [flashcardIds],
    );

    const { rows: topics } = await this.pool.query<{
      id: number;
      label: string;
      parent_id: number | null;
      card_count: string;
    }>(
      `SELECT t.id, t.label, t.parent_id, COUNT(f.id) AS card_count
       FROM topics t
       LEFT JOIN flashcards f ON f.topic_id = t.id
       GROUP BY t.id, t.label, t.parent_id
       ORDER BY t.label`,
    );

    const prompt = `You are a topic classifier for a flashcard learning system.

${
  topics.length > 0
    ? `Existing topics:\n${topics.map((t) => `- ID ${t.id}: ${t.label} (${t.card_count} cards)`).join("\n")}`
    : "There are no existing topics yet."
}

Flashcards to classify:
${cards.map((c) => `- ID ${c.id}: Q: ${c.question} / A: ${c.answer}`).join("\n")}

For each flashcard, assign it to the most relevant existing topic (provide topicId), or propose a concise new topic label if none fit (provide newTopicLabel). Respond with valid JSON only:
{"assignments":[{"flashcardId":1,"topicId":3},{"flashcardId":2,"newTopicLabel":"Recursion"}]}`;

    const raw = await this._callLlm(prompt);
    if (!raw) return;

    let assignments: AssignmentEntry[];
    try {
      assignments = (JSON.parse(raw) as { assignments: AssignmentEntry[] }).assignments;
    } catch {
      const retry = await this._callLlm(
        prompt + "\n\nIMPORTANT: Respond with valid JSON only, no other text.",
      );
      if (!retry) return;
      try {
        assignments = (JSON.parse(retry) as { assignments: AssignmentEntry[] }).assignments;
      } catch {
        console.error("[TopicAssignmentAgent] Failed to parse LLM response after retry");
        return;
      }
    }

    // Create new topics, deduplicating labels within this batch
    const newLabelToId = new Map<string, number>();
    for (const a of assignments) {
      if (a.newTopicLabel && !newLabelToId.has(a.newTopicLabel)) {
        const { rows } = await this.pool.query<{ id: number }>(
          "INSERT INTO topics (label) VALUES ($1) RETURNING id",
          [a.newTopicLabel],
        );
        newLabelToId.set(a.newTopicLabel, rows[0]!.id);
      }
    }

    // Assign each card
    const affectedTopicIds = new Set<number>();
    for (const a of assignments) {
      const topicId = a.topicId ?? newLabelToId.get(a.newTopicLabel ?? "");
      if (!topicId) continue;
      await this.pool.query("UPDATE flashcards SET topic_id = $1 WHERE id = $2", [
        topicId,
        a.flashcardId,
      ]);
      affectedTopicIds.add(topicId);
    }

    if (opts.skipAutoSplit) return;

    // Fire-and-forget split for topics that just crossed the threshold
    for (const topicId of affectedTopicIds) {
      const { rows } = await this.pool.query<{
        count: string;
        parent_id: number | null;
      }>(
        `SELECT COUNT(f.id) AS count, t.parent_id
         FROM topics t
         LEFT JOIN flashcards f ON f.topic_id = t.id
         WHERE t.id = $1
         GROUP BY t.parent_id`,
        [topicId],
      );
      if (rows[0] && parseInt(rows[0].count) >= 6 && rows[0].parent_id === null) {
        this.splitTopic(topicId).catch((err) =>
          console.error(`[TopicAssignmentAgent] splitTopic(${topicId}) failed:`, err),
        );
      }
    }
  }

  async splitTopic(topicId: number): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      // Idempotency: re-verify conditions inside the transaction
      const { rows: guard } = await client.query<{
        count: string;
        parent_id: number | null;
      }>(
        `SELECT COUNT(f.id) AS count, t.parent_id
         FROM topics t
         LEFT JOIN flashcards f ON f.topic_id = t.id
         WHERE t.id = $1
         GROUP BY t.parent_id`,
        [topicId],
      );

      if (!guard[0] || parseInt(guard[0].count) < 6 || guard[0].parent_id !== null) {
        await client.query("ROLLBACK");
        return;
      }

      const { rows: cards } = await client.query<{
        id: number;
        question: string;
        answer: string;
      }>("SELECT id, question, answer FROM flashcards WHERE topic_id = $1", [topicId]);

      const { rows: topicRows } = await client.query<{ label: string }>(
        "SELECT label FROM topics WHERE id = $1",
        [topicId],
      );
      const topicLabel = topicRows[0]?.label ?? "Unknown";

      const prompt = `You are reorganizing flashcards that have grown too numerous under one topic.

Current topic: "${topicLabel}" (being split into 2 groups)

Flashcards:
${cards.map((c) => `- ID ${c.id}: Q: ${c.question} / A: ${c.answer}`).join("\n")}

Split these into exactly 2 cohesive subtopic groups and give each a specific label. Every flashcard ID must appear in exactly one group. Respond with valid JSON only:
{"group1":{"label":"Specific Label A","flashcardIds":[1,3,5]},"group2":{"label":"Specific Label B","flashcardIds":[2,4,6]}}`;

      const raw = await this._callLlm(prompt);
      if (!raw) {
        await client.query("ROLLBACK");
        return;
      }

      let split: { group1: SplitGroup; group2: SplitGroup };
      try {
        split = JSON.parse(raw) as { group1: SplitGroup; group2: SplitGroup };
      } catch {
        console.error(`[TopicAssignmentAgent] splitTopic(${topicId}): malformed LLM response`);
        await client.query("ROLLBACK");
        return;
      }

      if (!split.group1?.flashcardIds?.length || !split.group2?.flashcardIds?.length) {
        console.warn(
          `[TopicAssignmentAgent] splitTopic(${topicId}): LLM did not produce 2 non-empty groups, aborting`,
        );
        await client.query("ROLLBACK");
        return;
      }

      const { rows: child1 } = await client.query<{ id: number }>(
        "INSERT INTO topics (label, parent_id) VALUES ($1, $2) RETURNING id",
        [split.group1.label, topicId],
      );
      const { rows: child2 } = await client.query<{ id: number }>(
        "INSERT INTO topics (label, parent_id) VALUES ($1, $2) RETURNING id",
        [split.group2.label, topicId],
      );

      await client.query("UPDATE flashcards SET topic_id = $1 WHERE id = ANY($2)", [
        child1[0]!.id,
        split.group1.flashcardIds,
      ]);
      await client.query("UPDATE flashcards SET topic_id = $1 WHERE id = ANY($2)", [
        child2[0]!.id,
        split.group2.flashcardIds,
      ]);

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  private async _callLlm(prompt: string): Promise<string | null> {
    try {
      const res = await this.openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_object" },
      });
      return res.choices[0]?.message.content ?? null;
    } catch (err) {
      console.error("[TopicAssignmentAgent] LLM call failed:", err);
      return null;
    }
  }
}
