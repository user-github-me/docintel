import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../../config/config';
import { AnthropicProvider } from './anthropic.provider';
import { AzureOpenAiProvider } from './azure-openai.provider';
import { LlmProvider, LlmRequest, LlmResult } from './provider';

/** Chooses the configured provider and caps concurrent LLM calls per process (rate-limit friendly). */
@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);
  private provider: LlmProvider | null;
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.provider = LlmService.create(config);
    this.logger.log(this.provider ? `LLM: ${this.provider.name} (${this.provider.model}), strategy=${config.LLM_STRATEGY}` : 'LLM disabled: rules-only extraction');
  }

  static create(config: AppConfig): LlmProvider | null {
    switch (config.llmProviderResolved) {
      case 'azure-openai':
        if (!config.AZURE_OPENAI_API_KEY || !config.AZURE_OPENAI_BASE_URL) return null;
        return new AzureOpenAiProvider({
          baseURL: config.AZURE_OPENAI_BASE_URL,
          apiKey: config.AZURE_OPENAI_API_KEY,
          deployment: config.AZURE_OPENAI_DEPLOYMENT,
          reasoningEffort: config.AZURE_OPENAI_REASONING_EFFORT,
          timeoutMs: config.LLM_TIMEOUT_MS,
          maxRetries: config.LLM_MAX_RETRIES,
        });
      case 'anthropic':
        return new AnthropicProvider({
          apiKey: config.ANTHROPIC_API_KEY,
          model: config.ANTHROPIC_MODEL,
          effort: config.ANTHROPIC_EFFORT,
          timeoutMs: config.LLM_TIMEOUT_MS,
          maxRetries: config.LLM_MAX_RETRIES,
        });
      default:
        return null;
    }
  }

  /** Test hook / runtime override. */
  setProvider(provider: LlmProvider | null): void {
    this.provider = provider;
  }

  get enabled(): boolean {
    return this.provider !== null && this.config.LLM_STRATEGY !== 'never';
  }

  info() {
    return { enabled: this.enabled, provider: this.provider?.name ?? null, model: this.provider?.model ?? null, strategy: this.config.LLM_STRATEGY };
  }

  private async acquire(): Promise<void> {
    if (this.active < this.config.LLM_CONCURRENCY) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active++;
  }

  private release(): void {
    this.active--;
    this.waiting.shift()?.();
  }

  async extract(request: LlmRequest): Promise<LlmResult> {
    if (!this.provider) throw new Error('LLM provider not configured');
    await this.acquire();
    try {
      return await this.provider.extract(request);
    } finally {
      this.release();
    }
  }
}
