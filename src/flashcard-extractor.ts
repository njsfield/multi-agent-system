import OpenAI from 'openai';
import pg from 'pg';

interface ExtractedQA {
  question: string;
  answer: string;
}

function cosineDist(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return 1 - dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export class FlashcardExtractor {
  constructor(
    private pool: pg.Pool,
    private openai: OpenAI,
  ) {}

  async extract(userMessage: string, assistantMessage: string): Promise<void> {
    if (!assistantMessage.trim()) return;

    const extracted = await this.extractQA(userMessage, assistantMessage);
    if (!extracted) return;

    const embRes = await this.openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: extracted.question,
    });
    const embedding = embRes.data[0]!.embedding;

    if (await this.isDuplicate(extracted.question, embedding)) return;

    const topicLabel = await this.findClosestTopic(embedding);

    await this.pool.query(
      `INSERT INTO flashcards (question, answer, topic_label, embedding)
       VALUES ($1, $2, $3, $4)`,
      [extracted.question, extracted.answer, topicLabel, JSON.stringify(embedding)],
    );
  }

  private async extractQA(userMessage: string, assistantMessage: string): Promise<ExtractedQA | null> {
    const res = await this.openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{
        role: 'user',
        content: `Given this conversation exchange, extract a single clear factual question and answer suitable for spaced repetition learning. If no clear fact was taught, respond with {"result":null}.\n\nUser: ${userMessage}\n\nAssistant: ${assistantMessage}\n\nReply as JSON: {"question": "...", "answer": "..."} or {"result": null}`,
      }],
    });

    const text = res.choices[0]?.message.content ?? '';
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      if (!parsed || parsed['result'] === null || !parsed['question'] || !parsed['answer']) return null;
      return { question: String(parsed['question']), answer: String(parsed['answer']) };
    } catch {
      return null;
    }
  }

  private async isDuplicate(question: string, embedding: number[]): Promise<boolean> {
    const { rows } = await this.pool.query<{ question: string }>(
      `SELECT question FROM flashcards WHERE embedding <=> $1 < 0.15 LIMIT 5`,
      [JSON.stringify(embedding)],
    );
    if (rows.length === 0) return false;

    const candidates = rows.map(r => r.question).join('\n- ');
    const res = await this.openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{
        role: 'user',
        content: `Is this new question asking about the same concept as any existing question?\n\nNew: ${question}\n\nExisting:\n- ${candidates}\n\nReply as JSON: {"isDuplicate": true} or {"isDuplicate": false}`,
      }],
    });

    try {
      const parsed = JSON.parse(res.choices[0]?.message.content ?? '{}') as Record<string, unknown>;
      return parsed['isDuplicate'] === true;
    } catch {
      return false;
    }
  }

  private async findClosestTopic(embedding: number[]): Promise<string | null> {
    const { rows } = await this.pool.query<{
      graph: { nodes: Array<{ type: string; data: { label: string } }> };
    }>('SELECT graph FROM mindmap_cache WHERE id = 1');

    if (!rows[0]) return null;

    const topicLabels = rows[0].graph.nodes
      .filter(n => n.type === 'topic')
      .map(n => n.data.label);
    if (topicLabels.length === 0) return null;

    const topicEmbeddings = await Promise.all(
      topicLabels.map(label =>
        this.openai.embeddings.create({ model: 'text-embedding-3-small', input: label })
          .then(r => ({ label, embedding: r.data[0]!.embedding })),
      ),
    );

    let closestLabel: string | null = null;
    let closestDist = Infinity;
    for (const { label, embedding: topicEmb } of topicEmbeddings) {
      const dist = cosineDist(embedding, topicEmb);
      if (dist < closestDist) { closestDist = dist; closestLabel = label; }
    }
    return closestLabel;
  }
}
