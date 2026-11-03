import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { AnthropicProvider } from './anthropic.provider';
import { AzureOpenAiProvider } from './azure-openai.provider';
import { LlmError } from './provider';
import { LlmInvoice } from './schema';
import { SYSTEM_PROMPT } from './prompt';

const parsed = { is_invoice: true, document_type: 'invoice', notes: [], line_items: [] } as unknown as LlmInvoice;
const request = { documentText: '<document>\nInvoice No: A-1\n</document>', images: [{ page: 1, mediaType: 'image/jpeg' as const, base64: 'AAAA' }] };

describe('AzureOpenAiProvider', () => {
  const cfg = { baseURL: 'https://x.openai.azure.com/openai/v1', apiKey: 'k'.repeat(20), deployment: 'gpt-6-astra', reasoningEffort: 'low' as const, timeoutMs: 1000, maxRetries: 0 };

  it('sends a strict structured-output request without server-side storage', async () => {
    const parse = jest.fn().mockResolvedValue({ status: 'completed', output: [], output_parsed: parsed, model: 'gpt-6-astra', usage: { input_tokens: 120, output_tokens: 30 } });
    const provider = new AzureOpenAiProvider(cfg, { responses: { parse } } as unknown as OpenAI);
    const result = await provider.extract(request);
    const body = parse.mock.calls[0][0];
    expect(body).toMatchObject({ model: 'gpt-6-astra', instructions: SYSTEM_PROMPT, store: false, reasoning: { effort: 'low' } });
    expect(body.text.format.type).toBe('json_schema');
    expect(body.text.format.strict).toBe(true);
    expect(body.input[0].content[0]).toMatchObject({ type: 'input_image', image_url: 'data:image/jpeg;base64,AAAA' });
    expect(body.input[0].content[1].text).toContain('Invoice No: A-1');
    expect(result.usage).toMatchObject({ provider: 'azure-openai', input_tokens: 120, output_tokens: 30, used_vision: true });
  });

  it('maps refusals, truncation and missing output to typed errors', async () => {
    const refusal = { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }], output_parsed: null };
    await expect(new AzureOpenAiProvider(cfg, { responses: { parse: jest.fn().mockResolvedValue(refusal) } } as unknown as OpenAI).extract(request)).rejects.toMatchObject({ code: 'refusal' });
    const incomplete = { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] };
    await expect(new AzureOpenAiProvider(cfg, { responses: { parse: jest.fn().mockResolvedValue(incomplete) } } as unknown as OpenAI).extract(request)).rejects.toMatchObject({ code: 'truncated' });
    const empty = { status: 'completed', output: [], output_parsed: null };
    await expect(new AzureOpenAiProvider(cfg, { responses: { parse: jest.fn().mockResolvedValue(empty) } } as unknown as OpenAI).extract(request)).rejects.toBeInstanceOf(LlmError);
  });
});

describe('AnthropicProvider', () => {
  const cfg = { apiKey: 'k', model: 'claude-opus-5-5', effort: 'medium' as const, timeoutMs: 1000, maxRetries: 0 };

  it('uses structured outputs, a cached system prompt, explicit effort and server-side fallback', async () => {
    const parse = jest.fn().mockResolvedValue({ stop_reason: 'end_turn', parsed_output: parsed, model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 90 } });
    const provider = new AnthropicProvider(cfg, { beta: { messages: { parse } } } as unknown as Anthropic);
    const result = await provider.extract(request);
    const body = parse.mock.calls[0][0];
    expect(body).toMatchObject({ model: 'claude-opus-5-5', fallbacks: 'default', betas: ['server-side-fallback-2026-07-01'] });
    expect(body.system[0]).toMatchObject({ text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } });
    expect(body.output_config.effort).toBe('medium');
    expect(body.output_config.format).toBeDefined();
    expect(body.messages[0].content[0]).toMatchObject({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } });
    expect(result.usage.input_tokens).toBe(100);
  });

  it('turns refusal and max_tokens stops into typed errors', async () => {
    const mk = (r: object) => new AnthropicProvider(cfg, { beta: { messages: { parse: jest.fn().mockResolvedValue(r) } } } as unknown as Anthropic);
    await expect(mk({ stop_reason: 'refusal', stop_details: { category: 'cyber' }, parsed_output: null, usage: {} }).extract(request)).rejects.toMatchObject({ code: 'refusal' });
    await expect(mk({ stop_reason: 'max_tokens', parsed_output: null, usage: {} }).extract(request)).rejects.toMatchObject({ code: 'truncated' });
  });
});
