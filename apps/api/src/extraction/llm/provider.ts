import { LlmUsage } from '../types';
import { LlmInvoice } from './schema';

export interface LlmImage {
  page: number;
  mediaType: 'image/jpeg' | 'image/png';
  base64: string;
}

export interface LlmRequest {
  documentText: string;
  images: LlmImage[];
}

export interface LlmResult {
  output: LlmInvoice;
  usage: LlmUsage;
}

/** Provider-neutral contract; adapters exist for Azure OpenAI (default here) and Anthropic Claude. */
export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  extract(request: LlmRequest): Promise<LlmResult>;
}

export class LlmError extends Error {
  constructor(
    public readonly code: 'refusal' | 'truncated' | 'no_output' | 'api_error' | 'timeout' | 'auth',
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
  }
}
