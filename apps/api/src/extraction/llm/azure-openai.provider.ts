import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { buildDocumentPrompt } from './request';
import { LlmError, LlmProvider, LlmRequest, LlmResult } from './provider';
import { LlmInvoiceSchema } from './schema';
import { SYSTEM_PROMPT } from './prompt';

export interface AzureOpenAiConfig {
  baseURL: string; // https://<resource>.openai.azure.com/openai/v1
  apiKey: string;
  deployment: string;
  reasoningEffort: 'minimal' | 'low' | 'medium' | 'high';
  timeoutMs: number;
  maxRetries: number;
}

/**
 * Azure OpenAI (Azure AI Foundry) through the GA v1 API, which is OpenAI-wire-compatible, so the
 * official `openai` SDK is used with an `api-key` header. Structured Outputs (strict JSON schema)
 * guarantee the response shape; `store: false` keeps documents out of server-side response storage.
 */
export class AzureOpenAiProvider implements LlmProvider {
  readonly name = 'azure-openai';
  private readonly client: OpenAI;

  constructor(private readonly cfg: AzureOpenAiConfig, client?: OpenAI) {
    this.client =
      client ??
      new OpenAI({
        apiKey: cfg.apiKey,
        baseURL: cfg.baseURL,
        defaultHeaders: { 'api-key': cfg.apiKey },
        timeout: cfg.timeoutMs,
        maxRetries: cfg.maxRetries, // SDK retries 408/409/429/5xx with exponential backoff
      });
  }

  get model(): string {
    return this.cfg.deployment;
  }

  async extract(request: LlmRequest): Promise<LlmResult> {
    const started = Date.now();
    const content: OpenAI.Responses.ResponseInputContent[] = [
      ...request.images.map(
        (img): OpenAI.Responses.ResponseInputImage => ({ type: 'input_image', image_url: `data:${img.mediaType};base64,${img.base64}`, detail: 'high' }),
      ),
      { type: 'input_text', text: buildDocumentPrompt(request) },
    ];
    let response;
    try {
      response = await this.client.responses.parse({
        model: this.cfg.deployment,
        instructions: SYSTEM_PROMPT,
        input: [{ role: 'user', content }],
        text: { format: zodTextFormat(LlmInvoiceSchema, 'invoice_extraction') },
        reasoning: { effort: this.cfg.reasoningEffort },
        max_output_tokens: 16000,
        store: false,
      });
    } catch (err) {
      if (err instanceof OpenAI.AuthenticationError || err instanceof OpenAI.PermissionDeniedError) {
        throw new LlmError('auth', `Azure OpenAI rejected the credentials (${err.status})`);
      }
      if (err instanceof OpenAI.APIConnectionTimeoutError) throw new LlmError('timeout', 'Azure OpenAI request timed out', true);
      if (err instanceof OpenAI.RateLimitError) throw new LlmError('api_error', 'Azure OpenAI rate limit exhausted after retries', true);
      if (err instanceof OpenAI.APIError) throw new LlmError('api_error', `Azure OpenAI error ${err.status ?? ''}: ${err.message}`, (err.status ?? 500) >= 500);
      throw err;
    }
    if (response.status === 'incomplete') {
      throw new LlmError('truncated', `response incomplete: ${response.incomplete_details?.reason ?? 'unknown'}`);
    }
    for (const item of response.output) {
      if (item.type !== 'message') continue;
      for (const part of item.content) {
        if (part.type === 'refusal') throw new LlmError('refusal', `model declined: ${part.refusal}`);
      }
    }
    if (!response.output_parsed) throw new LlmError('no_output', 'no parseable structured output');
    return {
      output: response.output_parsed,
      usage: {
        provider: this.name,
        model: response.model ?? this.cfg.deployment,
        input_tokens: response.usage?.input_tokens ?? 0,
        output_tokens: response.usage?.output_tokens ?? 0,
        latency_ms: Date.now() - started,
        used_vision: request.images.length > 0,
      },
    };
  }
}
