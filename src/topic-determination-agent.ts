import pg from 'pg';
import { OpenAIAgent } from './openai-agent';
import { FunctionTool } from './tool';

export interface TopicAssignment {
  topicId: number;
  topicLabel: string;
  subtopic: string;
}

export function createTopicDeterminationAgent(pool: pg.Pool): OpenAIAgent {
  const fetchTopicsTool = new FunctionTool(
    async (params) => {
      try {
        const { rows } = await pool.query<{ id: number; label: string }>(
          'SELECT id, label FROM topics ORDER BY id ASC',
        );
        return JSON.stringify(rows);
      } catch (err) {
        return JSON.stringify({ error: `Database error: ${String(err)}` });
      }
    },
    'fetch_topics',
    'Fetch all available topics from the database. Returns a JSON array of {id, label} objects.',
    {
      type: 'object',
      properties: {},
      required: [],
    },
  );

  const classifyMessageTool = new FunctionTool(
    (params) => {
      const message = String(params['message'] ?? '').trim();
      const topicId = Number(params['topic_id']);
      const subtopic = String(params['subtopic'] ?? '').trim();

      if (!message || isNaN(topicId) || !subtopic) {
        return JSON.stringify({
          error: 'Missing required parameters: message, topic_id, subtopic',
        });
      }

      return JSON.stringify({
        success: true,
        message,
        topicId,
        subtopic,
      });
    },
    'classify_message',
    'Classify a message into a topic and assign a subtopic. Returns confirmation of the classification.',
    {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'The message to classify',
        },
        topic_id: {
          type: 'number',
          description: 'The ID of the most relevant topic from the available topics',
        },
        subtopic: {
          type: 'string',
          description: 'A specific subtopic or variation within that category (2-5 words)',
        },
      },
      required: ['message', 'topic_id', 'subtopic'],
    },
  );

  return new OpenAIAgent(
    'topic-determiner',
    `You are a topic classification specialist. Your task is to classify user messages into appropriate topics.

When you receive a message to classify:
1. First, call fetch_topics to get the list of available topics
2. Analyze the message and determine which topic is most relevant
3. Decide on a specific subtopic (variation within that category)
4. Call classify_message with the message, topic_id, and subtopic

Always choose the most relevant topic, even if the match isn't perfect. Respond with the classification result.`,
    {
      tools: [fetchTopicsTool, classifyMessageTool],
      streamTokens: false,
    },
  );
}

export async function determineMessageTopic(
  message: string,
  pool: pg.Pool,
): Promise<TopicAssignment | null> {
  if (!message.trim()) return null;

  const agent = createTopicDeterminationAgent(pool);
  const prompt = `Classify this message into one of the available topics:

"${message}"

Use the fetch_topics tool to get available topics, then use classify_message to provide your classification.`;

  try {
    const response = await agent.run(prompt);
    const lastMessage = response.messages.at(-1);

    if (!lastMessage) return null;

    // Parse the response to extract topic assignment
    const content = lastMessage.content;

    // Look for the pattern from classify_message response
    const match = content.match(/"topicId"\s*:\s*(\d+)/);
    if (!match) return null;

    const topicId = parseInt(match[1]!, 10);

    // Get the topic label from the database
    const { rows } = await pool.query<{ label: string }>(
      'SELECT label FROM topics WHERE id = $1',
      [topicId],
    );

    if (!rows[0]) return null;

    // Extract subtopic from the response
    const subtopicMatch = content.match(/"subtopic"\s*:\s*"([^"]+)"/);
    const subtopic = subtopicMatch ? subtopicMatch[1]! : 'general';

    return {
      topicId,
      topicLabel: rows[0].label,
      subtopic,
    };
  } catch (err) {
    console.error('[determineMessageTopic] Classification failed:', err);
    return null;
  }
}
