import * as api from "@opentelemetry/api";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { MeterProvider } from "@opentelemetry/sdk-metrics";
import { BaseMiddleware, MiddlewareContext } from "./middleware";
import { ChatCompletionResult } from "./types";

const DEFAULT_TRACER_NAME = "ts-agent";

function toJson(value: unknown): string {
  try {
    return JSON.stringify(value, (_k, v) =>
      typeof v === "bigint" ? v.toString() : v,
    );
  } catch {
    return String(value);
  }
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

export class OtelMiddleware extends BaseMiddleware {
  private tracer: api.Tracer;
  private tokenHistogram: api.Histogram;
  private durationHistogram: api.Histogram;
  private captureContent: boolean;
  private tracerName: string;
  private endpoint: string;

  constructor(
    tracerName = DEFAULT_TRACER_NAME,
    captureContent = true,
    endpoint = "http://localhost:4318",
  ) {
    super();
    this.captureContent = captureContent;
    this.tracerName = tracerName;
    this.endpoint = endpoint;

    const meter = api.metrics.getMeter(this.tracerName);
    this.tracer = api.trace.getTracer(this.tracerName);

    this.tokenHistogram = meter.createHistogram("gen_ai.client.token.usage", {
      unit: "{token}",
      description: "Token usage per request",
    });

    this.durationHistogram = meter.createHistogram(
      "gen_ai.client.operation.duration",
      {
        unit: "s",
        description: "Operation duration",
      },
    );
  }

  async processRequest(context: MiddlewareContext): Promise<MiddlewareContext> {
    const model = String(context.data["model"] ?? "unknown");
    const toolName = String(context.data["toolName"] ?? "unknown");

    const spanName =
      context.operation === "model_call"
        ? `chat ${model}`
        : context.operation === "tool_call"
          ? `execute_tool ${toolName}`
          : context.operation;

    const span = this.tracer.startSpan(spanName);

    span.setAttribute(
      "gen_ai.operation.name",
      context.operation === "model_call" ? "chat" : "execute_tool",
    );
    span.setAttribute("gen_ai.provider.name", "openai");
    span.setAttribute("gen_ai.agent.name", context.agentName);

    if (context.operation === "model_call") {
      span.setAttribute("gen_ai.request.model", model);
      if (this.captureContent) {
        const messages =
          (context.data["messages"] as Array<{
            role: string;
            content: string;
          }>) ?? [];
        span.setAttribute(
          "gen_ai.input.messages",
          toJson(messages.map((m) => ({ role: m.role, content: m.content }))),
        );
      }
    } else if (context.operation === "tool_call") {
      span.setAttribute("gen_ai.tool.name", toolName);
      span.setAttribute(
        "gen_ai.tool.call.id",
        String(context.data["callId"] ?? ""),
      );
      if (this.captureContent) {
        span.setAttribute(
          "gen_ai.tool.parameters",
          toJson(context.data["parameters"] ?? {}),
        );
      }
    }

    context.metadata["_otelSpan"] = span;
    context.metadata["_otelStartTime"] = Date.now();
    return context;
  }

  async processResponse(
    context: MiddlewareContext,
    result: unknown,
  ): Promise<unknown> {
    const span = context.metadata["_otelSpan"] as api.Span | undefined;
    const startTime = context.metadata["_otelStartTime"] as number | undefined;
    const duration = startTime != null ? (Date.now() - startTime) / 1000 : 0;

    if (!span) return result;

    if (this.isChatCompletionResult(result)) {
      const cr = result as ChatCompletionResult;
      if (cr.usage) {
        this.tokenHistogram.record(cr.usage.tokens, {
          "gen_ai.token.type": "input",
        });
        this.tokenHistogram.record(cr.usage.tokensOutput, {
          "gen_ai.token.type": "output",
        });
        span.setAttribute("gen_ai.usage.input_tokens", cr.usage.tokens);
        span.setAttribute("gen_ai.usage.output_tokens", cr.usage.tokensOutput);
      }
      if (cr.finishReason)
        span.setAttribute("gen_ai.response.finish_reasons", [cr.finishReason]);
      if (cr.model) span.setAttribute("gen_ai.response.model", cr.model);
      if (this.captureContent && cr.message) {
        span.setAttribute(
          "gen_ai.output.messages",
          toJson([{ role: "assistant", content: cr.message.content }]),
        );
      }
    } else if (this.isToolMessage(result)) {
      const tm = result as { success: boolean; content: string };
      span.setAttribute("gen_ai.tool.success", tm.success);
      if (this.captureContent)
        span.setAttribute("gen_ai.tool.result", tm.content);
    }

    this.durationHistogram.record(duration);
    span.setAttribute("gen_ai.operation.duration", duration);
    span.setStatus({ code: api.SpanStatusCode.OK });
    span.end();

    return result;
  }

  async processError(context: MiddlewareContext, error: Error): Promise<void> {
    const span = context.metadata["_otelSpan"] as api.Span | undefined;
    if (span) {
      span.setStatus({
        code: api.SpanStatusCode.ERROR,
        message: error.message,
      });
      span.recordException(error);
      span.end();
    }
    throw error;
  }

  private isChatCompletionResult(
    value: unknown,
  ): value is ChatCompletionResult {
    return (
      typeof value === "object" &&
      value !== null &&
      "message" in value &&
      "finishReason" in value
    );
  }

  private isToolMessage(
    value: unknown,
  ): value is { success: boolean; content: string } {
    return (
      typeof value === "object" &&
      value !== null &&
      "success" in value &&
      "toolCallId" in value
    );
  }

  // ---------------------------------------------------------------------------
  // Provider setup — call once at app startup
  // ---------------------------------------------------------------------------

  public setupOtelProviders(): void {
    const resource = resourceFromAttributes({
      "service.name": this.tracerName,
    });

    const tracerProvider = new NodeTracerProvider({
      resource,
      spanProcessors: [
        new BatchSpanProcessor(
          new OTLPTraceExporter({ url: `${this.endpoint}/v1/traces` }),
        ),
      ],
    });
    tracerProvider.register();

    const meterProvider = new MeterProvider({ resource });
    api.metrics.setGlobalMeterProvider(meterProvider);
  }
}
