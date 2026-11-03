import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const EnvSchema = z.object({
  NODE_ENV: z.string().default('development'),
  APP_ROLE: z.enum(['all', 'api', 'worker']).default('all'),
  PORT: z.coerce.number().int().default(4000),
  DATABASE_URL: z.string().default('postgres://docintel:docintel@localhost:5432/docintel'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  PROCESSOR_URL: z.string().default('http://localhost:8000'),
  STORAGE_DIR: z.string().default('../../storage'),
  API_KEYS: z.string().default('admin:dev-admin-key-change-me'),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),
  MAX_UPLOAD_MB: z.coerce.number().default(200),
  MAX_FILES_PER_REQUEST: z.coerce.number().int().default(50),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().default(600),
  PAGE_CHUNK_SIZE: z.coerce.number().int().min(1).max(200).default(16),
  WORKER_CONCURRENCY_INGEST: z.coerce.number().int().default(4),
  WORKER_CONCURRENCY_PAGES: z.coerce.number().int().default(4),
  WORKER_CONCURRENCY_ANALYZE: z.coerce.number().int().default(6),
  WORKER_CONCURRENCY_INDEX: z.coerce.number().int().default(1),
  JOB_ATTEMPTS: z.coerce.number().int().default(3),
  PROCESSOR_TIMEOUT_MS: z.coerce.number().int().default(600_000),
  // LLM
  LLM_PROVIDER: z.enum(['auto', 'azure-openai', 'anthropic', 'none']).default('auto'),
  LLM_STRATEGY: z.enum(['always', 'fallback', 'never']).default('fallback'),
  LLM_CONCURRENCY: z.coerce.number().int().min(1).default(4),
  LLM_TIMEOUT_MS: z.coerce.number().int().default(240_000),
  LLM_MAX_RETRIES: z.coerce.number().int().default(2),
  LLM_VISION_FALLBACK: bool.default(true),
  LLM_VISION_MAX_PAGES: z.coerce.number().int().default(4),
  LLM_VISION_BELOW_OCR_CONF: z.coerce.number().default(0.9),
  AZURE_OPENAI_BASE_URL: z.string().optional(),
  AZURE_OPENAI_API_KEY: z.string().optional(),
  AZURE_OPENAI_DEPLOYMENT: z.string().default('gpt-6-astra'),
  AZURE_OPENAI_REASONING_EFFORT: z.enum(['minimal', 'low', 'medium', 'high']).default('low'),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default('claude-opus-5-5'),
  ANTHROPIC_EFFORT: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('medium'),
  // Validation / search
  VALIDATION_TOLERANCE: z.coerce.number().default(0.05),
  REVIEW_CONFIDENCE: z.coerce.number().default(0.75),
  EMBEDDINGS_ENABLED: bool.default(true),
  RUN_MIGRATIONS: bool.default(true),
  QUEUE_PREFIX: z.string().regex(/^[a-z0-9-]+$/).default('docintel'),
});

export type Env = z.infer<typeof EnvSchema>;

export interface ApiKey {
  name: string;
  key: string;
}

export interface AppConfig extends Env {
  storageDir: string;
  apiKeys: ApiKey[];
  corsOrigins: string[];
  llmProviderResolved: 'azure-openai' | 'anthropic' | 'none';
}

/** Load .env files (repo root then app dir) without overriding real environment variables. */
function loadDotEnv(): void {
  for (const file of [path.resolve(process.cwd(), '../../.env'), path.resolve(process.cwd(), '.env')]) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (!m || line.trim().startsWith('#')) continue;
      if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

let cached: AppConfig | null = null;

export function loadConfig(overrides: Record<string, string | undefined> = {}): AppConfig {
  if (cached && !Object.keys(overrides).length) return cached;
  loadDotEnv();
  const env = EnvSchema.parse({ ...process.env, ...overrides });
  const apiKeys = env.API_KEYS.split(',')
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const idx = pair.indexOf(':');
      return idx > 0 ? { name: pair.slice(0, idx), key: pair.slice(idx + 1) } : { name: 'default', key: pair };
    })
    .filter((k) => k.key.length >= 12);
  if (!apiKeys.length) throw new Error('API_KEYS must contain at least one key of 12+ characters (name:key)');
  let provider: AppConfig['llmProviderResolved'] = 'none';
  if (env.LLM_PROVIDER === 'auto') {
    if (env.AZURE_OPENAI_API_KEY && env.AZURE_OPENAI_BASE_URL) provider = 'azure-openai';
    else if (env.ANTHROPIC_API_KEY) provider = 'anthropic';
  } else provider = env.LLM_PROVIDER;
  if (env.LLM_STRATEGY === 'never') provider = 'none';
  const config: AppConfig = {
    ...env,
    storageDir: path.resolve(process.cwd(), env.STORAGE_DIR),
    apiKeys,
    corsOrigins: env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
    llmProviderResolved: provider,
  };
  if (!Object.keys(overrides).length) cached = config;
  return config;
}

export const APP_CONFIG = Symbol('APP_CONFIG');
