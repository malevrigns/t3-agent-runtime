import http from 'node:http';
import https from 'node:https';
import type {
  ModelAdapter,
  ModelCallOptions,
  ModelRequest,
  ModelResponse,
} from './ports.js';
import { ModelError } from './ports.js';
import type { ContentBlock } from '../core/types.js';

export interface OpenAICompatibleConfig {
  apiKey: string;
  baseURL?: string;
  proxy?: string; // 如 http://127.0.0.1:10808
}

export function toOpenAIUserContent(blocks: ContentBlock[]): string | Array<Record<string, unknown>> {
  const hasAttachment = blocks.some((b) => b.type === 'image' || b.type === 'file');
  if (!hasAttachment) {
    return blocks.map((c) => (c.type === 'text' ? c.text : '')).join('');
  }

  const parts: Array<Record<string, unknown>> = [];
  for (const block of blocks) {
    if (block.type === 'text') {
      parts.push({ type: 'text', text: block.text });
    } else if (block.type === 'image') {
      const url = block.url ?? (block.data ? `data:${block.mimeType};base64,${block.data}` : '');
      if (url) {
        parts.push({
          type: 'image_url',
          image_url: { url },
        });
      }
    } else if (block.type === 'file') {
      const attrs = `name="${block.name}" mime="${block.mimeType}"${block.sizeBytes !== undefined ? ` bytes="${block.sizeBytes}"` : ''}`;
      const body = block.text !== undefined
        ? block.text
        : block.data
        ? `[binary attachment base64 length=${block.data.length}]`
        : '[empty attachment]';
      parts.push({
        type: 'text',
        text: `<attachment ${attrs}>\n${body}\n</attachment>`,
      });
    }
  }
  return parts;
}

export class OpenAICompatibleAdapter implements ModelAdapter {
  readonly providerId = 'openai-compatible';
  readonly capabilities = {
    toolCalling: true,
    streaming: true,
    contextWindow: 128_000,
  };

  private apiKey: string;
  private baseURL: string;
  private proxyUrl?: URL;

  constructor(config: OpenAICompatibleConfig) {
    this.apiKey = config.apiKey;
    this.baseURL = (config.baseURL ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
    const proxyStr = config.proxy ?? process.env.HTTP_PROXY ?? process.env.ALL_PROXY;
    if (proxyStr) {
      try {
        this.proxyUrl = new URL(proxyStr);
      } catch {
        // 忽略无效代理配置
      }
    }
  }

  async generate(req: ModelRequest, opts: ModelCallOptions): Promise<ModelResponse> {
    const targetUrl = new URL(`${this.baseURL}/chat/completions`);

    // 1. 组装 messages
    const messages: any[] = [];
    if (req.system) {
      messages.push({ role: 'system', content: req.system });
    }

    for (const msg of req.messages) {
      if (msg.role === 'user') {
        messages.push({ role: 'user', content: toOpenAIUserContent(msg.content) });
      } else if (msg.role === 'assistant') {
        let text = '';
        const tool_calls: any[] = [];
        for (const block of msg.content) {
          if (block.type === 'text') {
            text += block.text;
          } else if (block.type === 'tool_call') {
            tool_calls.push({
              id: block.toolCallId,
              type: 'function',
              function: {
                name: block.toolName,
                arguments: typeof block.args === 'string' ? block.args : JSON.stringify(block.args),
              },
            });
          }
        }
        messages.push({
          role: 'assistant',
          content: text || null,
          ...(tool_calls.length > 0 ? { tool_calls } : {}),
        });
      } else if (msg.role === 'tool') {
        for (const block of msg.content) {
          if (block.type === 'tool_result') {
            messages.push({
              role: 'tool',
              tool_call_id: block.toolCallId,
              content: block.content,
            });
          }
        }
      }
    }

    // 2. 组装 tools
    const tools =
      req.tools.length > 0
        ? req.tools.map((t) => ({
            type: 'function',
            function: {
              name: t.name,
              description: t.description,
              parameters: t.inputSchema,
            },
          }))
        : undefined;

    const payload = JSON.stringify({
      model: req.model,
      messages,
      tools,
      stream: Boolean(opts.onDelta),
      max_tokens: req.maxOutputTokens,
      temperature: req.temperature ?? 0.2,
    });

    const isStream = Boolean(opts.onDelta);

    return new Promise<ModelResponse>((resolve, reject) => {
      if (opts.signal.aborted) {
        return reject(new ModelError('aborted', 'Request aborted by signal', false));
      }

      // 请求参数配置（通过 HTTP 代理隧道转发）
      let requestOptions: http.RequestOptions;
      if (this.proxyUrl) {
        requestOptions = {
          host: this.proxyUrl.hostname,
          port: Number(this.proxyUrl.port) || 80,
          method: 'POST',
          path: targetUrl.toString(),
          headers: {
            Host: targetUrl.host,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
            Authorization: `Bearer ${this.apiKey}`,
          },
        };
      } else {
        requestOptions = {
          protocol: targetUrl.protocol,
          hostname: targetUrl.hostname,
          port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
          method: 'POST',
          path: `${targetUrl.pathname}${targetUrl.search}`,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
            Authorization: `Bearer ${this.apiKey}`,
          },
        };
      }

      const transport = this.proxyUrl
        ? http
        : targetUrl.protocol === 'https:'
        ? https
        : http;

      const clientReq = transport.request(requestOptions, (res) => {
        const statusCode = res.statusCode || 500;
        if (statusCode >= 400) {
          let errBody = '';
          res.on('data', (c) => (errBody += c));
          res.on('end', () => {
            if (statusCode === 401 || statusCode === 403) {
              reject(new ModelError('auth', `Auth error (${statusCode}): ${errBody}`, false));
            } else if (statusCode === 429) {
              reject(new ModelError('rate_limit', `Rate limited (${statusCode}): ${errBody}`, true, 2000));
            } else if (statusCode >= 500) {
              reject(new ModelError('server', `Server error (${statusCode}): ${errBody}`, true));
            } else {
              reject(new ModelError('invalid_request', `Request error (${statusCode}): ${errBody}`, false));
            }
          });
          return;
        }

        if (isStream) {
          let buffer = '';
          let fullText = '';
          const toolCallsMap = new Map<number, { id: string; name: string; args: string }>();
          let finishReason: any = 'end_turn';
          let modelName = req.model;
          let streamUsage: { inputTokens: number; outputTokens: number } | null = null;

          res.on('data', (chunk) => {
            buffer += chunk.toString('utf-8');
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed || trimmed.startsWith(':')) continue;
              if (trimmed === 'data: [DONE]') continue;
              if (trimmed.startsWith('data: ')) {
                try {
                  const data = JSON.parse(trimmed.slice(6));
                  if (data.model) modelName = data.model;
                  if (data.usage && (typeof data.usage.prompt_tokens === 'number' || typeof data.usage.completion_tokens === 'number')) {
                    streamUsage = {
                      inputTokens: data.usage.prompt_tokens ?? 0,
                      outputTokens: data.usage.completion_tokens ?? 0,
                    };
                  }
                  const choice = data.choices?.[0];
                  if (choice?.finish_reason) finishReason = choice.finish_reason;

                  const delta = choice?.delta;
                  const reasoningChunk =
                    delta?.reasoning_content ?? delta?.reasoning ?? delta?.thinking;
                  if (typeof reasoningChunk === 'string' && reasoningChunk.length > 0) {
                    opts.onDelta?.({ type: 'reasoning_delta', text: reasoningChunk });
                  }
                  if (delta?.content) {
                    fullText += delta.content;
                    opts.onDelta?.({ type: 'text_delta', text: delta.content });
                  }
                  if (delta?.tool_calls) {
                    for (const tc of delta.tool_calls) {
                      const idx = tc.index ?? 0;
                      const cur = toolCallsMap.get(idx) ?? { id: '', name: '', args: '' };
                      if (tc.id) cur.id += tc.id;
                      if (tc.function?.name) cur.name += tc.function.name;
                      if (tc.function?.arguments) cur.args += tc.function.arguments;
                      toolCallsMap.set(idx, cur);
                      opts.onDelta?.({
                        type: 'tool_call_delta',
                        index: idx,
                        toolCallId: cur.id || undefined,
                        toolName: cur.name || undefined,
                        argsDelta: tc.function?.arguments,
                        argsText: cur.args,
                      });
                    }
                  }
                } catch {
                  // 忽略部分解析失败的 JSON 片段
                }
              }
            }
          });

          res.on('end', () => {
            const content: ContentBlock[] = [];
            if (fullText) content.push({ type: 'text', text: fullText });
            for (const tc of toolCallsMap.values()) {
              let parsedArgs: any = {};
              try {
                parsedArgs = JSON.parse(tc.args || '{}');
              } catch {
                parsedArgs = { __raw: tc.args };
              }
              content.push({
                type: 'tool_call',
                toolCallId: tc.id,
                toolName: tc.name,
                args: parsedArgs,
              });
            }

            resolve({
              content,
              finishReason: finishReason === 'tool_calls' ? 'tool_use' : finishReason === 'length' ? 'max_tokens' : 'stop',
              usage: streamUsage ?? {
                inputTokens: Math.ceil(fullText.length / 3) + 50,
                outputTokens: Math.ceil(fullText.length / 3),
              },
              model: modelName,
            });
          });
        } else {
          // 非流式
          let rawData = '';
          res.on('data', (c) => (rawData += c));
          res.on('end', () => {
            try {
              const data = JSON.parse(rawData);
              const choice = data.choices?.[0];
              const content: ContentBlock[] = [];
              if (choice?.message?.content) {
                content.push({ type: 'text', text: choice.message.content });
              }
              if (choice?.message?.tool_calls) {
                for (const tc of choice.message.tool_calls) {
                  let parsedArgs: any = {};
                  try {
                    parsedArgs = JSON.parse(tc.function.arguments || '{}');
                  } catch {
                    parsedArgs = { __raw: tc.function.arguments };
                  }
                  content.push({
                    type: 'tool_call',
                    toolCallId: tc.id,
                    toolName: tc.function.name,
                    args: parsedArgs,
                  });
                }
              }

              const rawReason = choice?.finish_reason;
              const mappedReason = rawReason === 'tool_calls' ? 'tool_use' : rawReason === 'length' ? 'max_tokens' : 'stop';

              resolve({
                content,
                finishReason: mappedReason,
                usage: {
                  inputTokens: data.usage?.prompt_tokens ?? 0,
                  outputTokens: data.usage?.completion_tokens ?? 0,
                },
                model: data.model ?? req.model,
                providerRequestId: data.id,
              });
            } catch (err: any) {
              reject(new ModelError('malformed_response', `Failed to parse response: ${err.message}`, false));
            }
          });
        }
      });

      const abortHandler = () => {
        clientReq.destroy();
        reject(new ModelError('aborted', 'Request aborted by signal', false));
      };

      opts.signal.addEventListener('abort', abortHandler, { once: true });

      clientReq.on('error', (err) => {
        opts.signal.removeEventListener('abort', abortHandler);
        reject(new ModelError('network', `Network error: ${err.message}`, true, undefined, err));
      });

      clientReq.write(payload);
      clientReq.end();
    });
  }
}
