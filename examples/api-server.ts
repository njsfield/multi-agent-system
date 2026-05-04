import path from "path";
import { config } from "dotenv";
import { OpenAIAgent } from "../src/openai-agent";
import { FunctionTool } from "../src/tool";
import { LoggingMiddleware } from "../src/middleware";
import { createAgentServer } from "../src/server";
import OpenAI from "openai";
import { PgVectorMemory, createPgPool } from "../src/pg-memory";
import { MindmapService } from "../src/mindmap";
import { ListMemory } from "../src/memory";
import type { BaseMemory } from "../src/memory";
import type { HistoryMessage } from "../src/types";
import { FlashcardService } from "../src/flashcard-service";
import { FlashcardExtractor } from "../src/flashcard-extractor";
import { createFlashcardSelectionAgent } from "../src/flashcard-agent";
import type { FlashcardCard } from "../src/flashcard-service";

config({ path: path.join(__dirname, "../.env") });

// ---------------------------------------------------------------------------
// WMO weather code → human-readable description
// ---------------------------------------------------------------------------

const WMO_CODES: Record<number, string> = {
  0: "Clear sky",
  1: "Mainly clear",
  2: "Partly cloudy",
  3: "Overcast",
  45: "Foggy",
  48: "Icy fog",
  51: "Light drizzle",
  53: "Moderate drizzle",
  55: "Dense drizzle",
  61: "Light rain",
  63: "Moderate rain",
  65: "Heavy rain",
  71: "Light snow",
  73: "Moderate snow",
  75: "Heavy snow",
  77: "Snow grains",
  80: "Light showers",
  81: "Moderate showers",
  82: "Heavy showers",
  85: "Light snow showers",
  86: "Heavy snow showers",
  95: "Thunderstorm",
  96: "Thunderstorm with hail",
  99: "Thunderstorm with heavy hail",
};

function wmoDescription(code: number): string {
  return WMO_CODES[code] ?? `Weather code ${code}`;
}

// ---------------------------------------------------------------------------
// Open-Meteo API helpers
// ---------------------------------------------------------------------------

interface GeoResult {
  name: string;
  country: string;
  latitude: number;
  longitude: number;
  timezone: string;
}

async function geocode(location: string): Promise<GeoResult> {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1&language=en&format=json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Geocoding request failed: ${res.status}`);
  const data = (await res.json()) as { results?: GeoResult[] };
  if (!data.results?.length)
    throw new Error(`Location not found: "${location}"`);
  return data.results[0];
}

async function fetchForecast(
  lat: number,
  lon: number,
  timezone: string,
  dateStr: string,
): Promise<string> {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    timezone,
    daily: [
      "temperature_2m_max",
      "temperature_2m_min",
      "weathercode",
      "precipitation_sum",
      "windspeed_10m_max",
      "winddirection_10m_dominant",
      "sunrise",
      "sunset",
      "uv_index_max",
    ].join(","),
    hourly: [
      "temperature_2m",
      "weathercode",
      "precipitation_probability",
      "windspeed_10m",
    ].join(","),
    start_date: dateStr,
    end_date: dateStr,
    wind_speed_unit: "mph",
    temperature_unit: "celsius",
    precipitation_unit: "mm",
  });

  const url = `https://api.open-meteo.com/v1/forecast?${params}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Weather request failed: ${res.status}`);
  return res.text();
}

// ---------------------------------------------------------------------------
// Weather tool — live data from Open-Meteo
// ---------------------------------------------------------------------------

const fetchWeatherTool = new FunctionTool(
  async (params) => {
    const location = String(params["location"] ?? "").trim();
    const dateArg = String(params["date"] ?? "today").toLowerCase();

    if (!location) return JSON.stringify({ error: "location is required" });

    // Resolve target date
    const today = new Date();
    const offset = dateArg.includes("tomorrow")
      ? 1
      : dateArg.includes("day after")
        ? 2
        : 0;
    const target = new Date(today);
    target.setDate(target.getDate() + offset);
    const dateStr = target.toISOString().split("T")[0]!;

    try {
      const geo = await geocode(location);
      const raw = await fetchForecast(
        geo.latitude,
        geo.longitude,
        geo.timezone,
        dateStr,
      );
      const data = JSON.parse(raw) as {
        daily: {
          time: string[];
          temperature_2m_max: number[];
          temperature_2m_min: number[];
          weathercode: number[];
          precipitation_sum: number[];
          windspeed_10m_max: number[];
          winddirection_10m_dominant: number[];
          sunrise: string[];
          sunset: string[];
          uv_index_max: number[];
        };
        hourly: {
          time: string[];
          temperature_2m: number[];
          weathercode: number[];
          precipitation_probability: number[];
          windspeed_10m: number[];
        };
      };

      const d = data.daily;
      const h = data.hourly;

      // Build compact hourly snapshot at 6-hour intervals
      const hourlySlots = h.time
        .map((t, i) => ({
          time: t.slice(11, 16),
          temp: Math.round(h.temperature_2m[i] ?? 0),
          conditions: wmoDescription(h.weathercode[i] ?? 0),
          rain_chance: `${h.precipitation_probability[i] ?? 0}%`,
          wind: `${Math.round(h.windspeed_10m[i] ?? 0)} mph`,
        }))
        .filter((s) =>
          ["06:00", "09:00", "12:00", "15:00", "18:00", "21:00"].includes(
            s.time,
          ),
        );

      const result = {
        location: `${geo.name}, ${geo.country}`,
        date: dateStr,
        source: "Open-Meteo (openmeteo.com)",
        conditions: wmoDescription(d.weathercode[0] ?? 0),
        temperature: {
          min: Math.round(d.temperature_2m_min[0] ?? 0),
          max: Math.round(d.temperature_2m_max[0] ?? 0),
          unit: "celsius",
        },
        precipitation_mm: d.precipitation_sum[0] ?? 0,
        wind_max_mph: Math.round(d.windspeed_10m_max[0] ?? 0),
        uv_index: Math.round(d.uv_index_max[0] ?? 0),
        sunrise: d.sunrise[0]?.slice(11, 16) ?? "N/A",
        sunset: d.sunset[0]?.slice(11, 16) ?? "N/A",
        hourly: hourlySlots,
      };

      return JSON.stringify(result);
    } catch (err) {
      return JSON.stringify({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
  "fetch_weather",
  "Fetch a live weather forecast from Open-Meteo for any city and date.",
  {
    type: "object",
    properties: {
      location: {
        type: "string",
        description: "City name, e.g. London, Tokyo, New York",
      },
      date: {
        type: "string",
        description: '"today", "tomorrow", or "day after tomorrow"',
      },
    },
    required: ["location", "date"],
  },
);

// ---------------------------------------------------------------------------
// Server startup
// ---------------------------------------------------------------------------

const PORT = 3000;

(async () => {
  // Attempt postgres connection; fall back to in-memory if unavailable
  let agentMemory: BaseMemory;
  let getHistory: ((limit: number) => Promise<HistoryMessage[]>) | undefined;
  let getFlashcard: (() => Promise<FlashcardCard | null>) | undefined;
  let reviewFlashcard:
    | ((id: number, score: string) => Promise<Date>)
    | undefined;
  let flashcardExtractor: FlashcardExtractor | undefined;
  let mindmapService: MindmapService | undefined;

  const DATABASE_URL =
    process.env["DATABASE_URL"] ?? "postgresql://localhost/tsagent";
  const openaiClient = new OpenAI({ apiKey: process.env["OPENAI_API_KEY"] });

  try {
    const pool = createPgPool(DATABASE_URL);
    await pool.query("SELECT 1"); // connection test
    const pgMemory = new PgVectorMemory(pool, openaiClient);
    agentMemory = pgMemory;
    getHistory = (limit) => pgMemory.getHistory(limit);

    const flashcardService = new FlashcardService(pool);
    const flashcardAgent = createFlashcardSelectionAgent(pool);
    flashcardExtractor = new FlashcardExtractor(pool, openaiClient);

    getFlashcard = async () => {
      const response = await flashcardAgent.run(
        "Select a flashcard for review.",
      );
      const lastMsg = response.messages.at(-1);
      if (!lastMsg) return null;
      try {
        const parsed = JSON.parse(lastMsg.content) as { id?: number | null };
        if (!parsed.id) return null;
        return flashcardService.getById(parsed.id);
      } catch {
        const match = lastMsg.content.match(/"id"\s*:\s*(\d+)/);
        if (!match) return null;
        return flashcardService.getById(parseInt(match[1]!, 10));
      }
    };

    reviewFlashcard = (id: number, score: string) =>
      flashcardService.applyReview(id, score);

    mindmapService = new MindmapService(pool, openaiClient);
    console.log("[startup] postgres memory: connected");
  } catch (err) {
    console.warn(
      "[startup] postgres unavailable, falling back to in-memory:",
      err,
    );
    agentMemory = new ListMemory();
  }

  function createWeatherAgent(): OpenAIAgent {
    return new OpenAIAgent(
      "weather-agent",
      `You are a helpful weather assistant with access to live forecast data.
Always call the fetch_weather tool first before answering any weather question.
Present results conversationally — include conditions, temperature range, wind,
chance of rain, and any notable hourly highlights. Be friendly and concise.`,
      {
        tools: [fetchWeatherTool],
        memory: agentMemory,
        middleware: [new LoggingMiddleware()],
        streamTokens: true,
      },
    );
  }

  const app = createAgentServer(
    async function* (message, signal) {
      let lastAssistantContent = "";
      for await (const item of createWeatherAgent().runStream(
        message,
        signal,
      )) {
        const obj = item as unknown as Record<string, unknown>;
        if (obj["role"] === "assistant" && typeof obj["content"] === "string") {
          lastAssistantContent = obj["content"];
        }
        yield item;
      }
      if (flashcardExtractor) {
        flashcardExtractor
          .extract(message, lastAssistantContent)
          .catch(console.error);
      }
      const agent = createWeatherAgent();
      yield* agent.runStream(message, signal);
      mindmapService?.recompute().catch(console.error);
    },
    {
      staticDir: path.join(__dirname, "../dist/ui"),
      getHistory,
      getFlashcard,
      reviewFlashcard,
      getMindmap: mindmapService ? () => mindmapService!.getGraph() : undefined,
    },
  );

  app.listen(PORT, () => {
    console.log(`\nWeather agent → http://localhost:${PORT}\n`);
    console.log(`  curl -sN -X POST http://localhost:${PORT}/chat \\`);
    console.log(`    -H 'Content-Type: application/json' \\`);
    console.log(
      `    -d '{"message": "What\\'s the weather in Tokyo tomorrow?"}'`,
    );
    console.log("");
  });
})();
