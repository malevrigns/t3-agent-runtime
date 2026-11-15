import type {
  ModelAdapter,
  ModelCallOptions,
  ModelDelta,
  ModelRequest,
  ModelResponse,
} from '../model/ports.js';
import type { ContentBlock } from '../core/types.js';

export type FakeScriptedHandler = (
  req: ModelRequest,
  opts: ModelCallOptions
) => ModelResponse | Promise<ModelResponse>;

export class FakeModelAdapter implements ModelAdapter {
  readonly providerId = 'fake-provider';
  readonly capabilities = {
    toolCalling: true,
    streaming: true,
    contextWindow: 128_000,
  };

  private scriptedResponses: FakeScriptedHandler[] = [];

  enqueueResponse(fn: FakeScriptedHandler): void {
    this.scriptedResponses.push(fn);
  }

  enqueueText(text: string): void {
    this.enqueueResponse(() => ({
      content: [{ type: 'text', text }],
      finishReason: 'stop',
      usage: { inputTokens: 50, outputTokens: 20 },
      model: 'fake-model',
    }));
  }

  enqueueToolCall(callId: string, toolName: string, args: unknown, thoughtText?: string): void {
    this.enqueueResponse(() => {
      const content: ContentBlock[] = [];
      if (thoughtText) {
        content.push({ type: 'text', text: thoughtText });
      }
      content.push({
        type: 'tool_call',
        toolCallId: callId,
        toolName,
        args,
      });
      return {
        content,
        finishReason: 'tool_use',
        usage: { inputTokens: 80, outputTokens: 40 },
        model: 'fake-model',
      };
    });
  }

  enqueueStreamedDeltas(input: {
    chunks: Array<{ delta: ModelDelta; delayMs?: number }>;
    response: ModelResponse | ((req: ModelRequest) => ModelResponse);
  }): void {
    this.enqueueResponse(async (req, opts) => {
      for (const chunk of input.chunks) {
        if (opts.signal.aborted) {
          throw new Error('Model request aborted');
        }
        if (chunk.delayMs && chunk.delayMs > 0) {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, chunk.delayMs);
            const onAbort = () => {
              clearTimeout(timer);
              reject(new Error('Model request aborted'));
            };
            opts.signal.addEventListener('abort', onAbort, { once: true });
          });
        }
        opts.onDelta?.(chunk.delta);
      }
      return typeof input.response === 'function' ? input.response(req) : input.response;
    });
  }

  async generate(req: ModelRequest, opts: ModelCallOptions): Promise<ModelResponse> {
    if (opts.signal.aborted) {
      throw new Error('Model request aborted');
    }

    const next = this.scriptedResponses.shift();
    if (!next) {
      // 默认结束回复
      return {
        content: [{ type: 'text', text: 'Default simulated response' }],
        finishReason: 'stop',
        usage: { inputTokens: 10, outputTokens: 10 },
        model: 'fake-model',
      };
    }

    const hadCustomStream = next.length >= 2;
    const resp = await next(req, opts);
    if (opts.onDelta && !hadCustomStream) {
      for (const block of resp.content) {
        if (block.type === 'text') {
          opts.onDelta({ type: 'text_delta', text: block.text });
        }
      }
    }

    return resp;
  }
}
