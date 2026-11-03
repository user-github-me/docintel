import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { buildDocumentPrompt } from './request';
import { LlmError, LlmProvider, LlmRequest, LlmResult } from './provider';
import { LlmInvoiceSchema } from './schema';
import { SYSTEM_PROMPT } from './prompt';

export interface AnthropicConfig {
  apiKey?: string;
  model: string; // default claude-opus-5-5
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  timeoutMs: number;
  maxRetries: number;
}

/**
 * Anthropic Claude adapter: structured outputs (output_config.format) with the SDK's zod parser,
 * a cache breakpoint on the static system prompt, explicit effort, and server-side refusal fallback.
 */
export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic';
  private readonly client: Anthropic;

  constructor(private readonly cfg: AnthropicConfig, client?: Anthropic) {
    this.client = client ?? new Anthropic({ apiKey: cfg.apiKey, timeout: cfg.timeoutMs, maxRetries: cfg.maxRetries });
  }

  get model(): string {
    return this.cfg.model;
  }

  async extract(request: LlmRequest): Promise<LlmResult> {
    const started = Date.now();
    const content: Anthropic.Beta.BetaContentBlockParam[] = [
      ...request.images.map((img) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: img.mediaType, data: img.base64 } })),
      { type: 'text', text: buildDocumentPrompt(request) },
    ];
    let response;
    try {
      response = await this.client.beta.messages.parse({
        model: this.cfg.model,
        max_tokens: 16000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content }],
        output_config: { effort: this.cfg.effort, format: betaZodOutputFormat(LlmInvoiceSchema) },
      });
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
        throw new LlmError('auth', `Anthropic rejected the credentials (${err.status})`);
      }
      if (err instanceof Anthropic.RateLimitError) throw new LlmError('api_error', 'Anthropic rate limit exhausted after retries', true);
      if (err instanceof Anthropic.APIConnectionTimeoutError) throw new LlmError('timeout', 'Anthropic request timed out', true);
      if (err instanceof Anthropic.APIError) throw new LlmError('api_error', `Anthropic error ${err.status ?? ''}: ${err.message}`, (err.status ?? 500) >= 500);
      throw err;
    }
    if (response.stop_reason === 'refusal') throw new LlmError('refusal', `model declined (${response.stop_details?.category ?? 'unspecified'})`);
    if (response.stop_reason === 'max_tokens') throw new LlmError('truncated', 'output hit max_tokens');
    if (!response.parsed_output) throw new LlmError('no_output', 'no parseable structured output');
    const usage = response.usage;
    return {
      output: response.parsed_output,
      usage: {
        provider: this.name,
        model: response.model,
        input_tokens: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
        output_tokens: usage.output_tokens ?? 0,
        latency_ms: Date.now() - started,
        used_vision: request.images.length > 0,
      },
    };
  }
}
