import path from "path";
import { config } from "dotenv";
import OpenAI from "openai";
import { createPgPool } from "../pg-memory";
import { TopicAssignmentAgent } from "../topic-assignment-agent";

config({ path: path.join(__dirname, "../../.env") });

const BATCH_SIZE = 20;

async function main() {
  const DATABASE_URL =
    process.env["DATABASE_URL"] ?? "postgresql://localhost/tsagent";
  const openaiClient = new OpenAI({ apiKey: process.env["OPENAI_API_KEY"] });
  const pool = createPgPool(DATABASE_URL);
  const agent = new TopicAssignmentAgent(pool, openaiClient);

  console.log("[backfill] Starting destructive topic reset...");

  // 1. Wipe all topics and assignments in a transaction
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("UPDATE flashcards SET topic_id = NULL");
    await client.query("DELETE FROM topics");
    await client.query("COMMIT");
    console.log("[backfill] All topics and assignments cleared.");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[backfill] Reset transaction failed, aborting:", err);
    process.exit(1);
  } finally {
    client.release();
  }

  // 2. Fetch all flashcard IDs
  const { rows: idRows } = await pool.query<{ id: number }>(
    "SELECT id FROM flashcards ORDER BY id ASC",
  );
  const allIds = idRows.map((r) => r.id);
  const total = allIds.length;

  if (total === 0) {
    console.log("[backfill] No flashcards found. Done.");
    await pool.end();
    return;
  }

  console.log(
    `[backfill] Processing ${total} flashcards in batches of ${BATCH_SIZE}...`,
  );

  // 3. Process in batches
  const batches: number[][] = [];
  for (let i = 0; i < allIds.length; i += BATCH_SIZE) {
    batches.push(allIds.slice(i, i + BATCH_SIZE));
  }

  let totalAssigned = 0;
  let totalTopicsCreated = 0;
  const failedBatches: number[] = [];

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i]!;
    try {
      const { rows: before } = await pool.query<{ count: string }>(
        "SELECT COUNT(*) AS count FROM topics",
      );
      const topicsBefore = parseInt(before[0]!.count);

      await agent.assignTopics(batch, { skipAutoSplit: true });
      totalAssigned += batch.length;

      const { rows: after } = await pool.query<{ count: string }>(
        "SELECT COUNT(*) AS count FROM topics",
      );
      const newTopics = parseInt(after[0]!.count) - topicsBefore;
      totalTopicsCreated += newTopics;

      console.log(
        `[backfill] batch ${i + 1}/${batches.length} — assigned ${batch.length} cards, created ${newTopics} new topics`,
      );
    } catch (err) {
      console.error(`[backfill] batch ${i + 1} failed:`, err);
      failedBatches.push(i + 1);
    }
  }

  // 4. Run splits sequentially for topics that exceeded the threshold
  console.log("[backfill] Checking for topics that need splitting...");
  const { rows: splitCandidates } = await pool.query<{
    id: number;
    label: string;
    count: string;
  }>(
    `SELECT t.id, t.label, COUNT(f.id) AS count
     FROM topics t
     LEFT JOIN flashcards f ON f.topic_id = t.id
     WHERE t.parent_id IS NULL
     GROUP BY t.id, t.label
     HAVING COUNT(f.id) >= 6`,
  );

  let totalSplit = 0;
  for (const topic of splitCandidates) {
    console.log(
      `[backfill] Splitting "${topic.label}" (${topic.count} cards)...`,
    );
    try {
      await agent.splitTopic(topic.id);
      totalSplit++;
    } catch (err) {
      console.error(`[backfill] Split failed for topic "${topic.label}":`, err);
    }
  }

  // 5. Summary
  console.log("\n[backfill] Complete!");
  console.log(`  Flashcards processed: ${totalAssigned}/${total}`);
  console.log(`  Topics created:       ${totalTopicsCreated}`);
  console.log(`  Topics split:         ${totalSplit}`);
  if (failedBatches.length > 0) {
    console.log(`  Failed batches:       ${failedBatches.join(", ")}`);
  }

  await pool.end();
}

main().catch((err) => {
  console.error("[backfill] Fatal error:", err);
  process.exit(1);
});
