import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { Pool, PoolClient, QueryResultRow, types } from 'pg';
import { APP_CONFIG, AppConfig } from '../config/config';

// Keep NUMERIC as strings (exact money), parse int8 counts as numbers, DATE as 'YYYY-MM-DD'.
types.setTypeParser(1700, (v) => v);
types.setTypeParser(20, (v) => Number(v));
types.setTypeParser(1082, (v) => v);

export type Queryable = Pick<PoolClient, 'query'>;

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  readonly pool: Pool;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.pool = new Pool({ connectionString: config.DATABASE_URL, max: 20, idleTimeoutMillis: 30_000 });
    this.pool.on('error', (err) => this.logger.error(`idle client error: ${err.message}`));
  }

  async query<T extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = [], client?: Queryable): Promise<T[]> {
    const res = await (client ?? this.pool).query<T>(sql, params as unknown[]);
    return res.rows;
  }

  async one<T extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = [], client?: Queryable): Promise<T | null> {
    const rows = await this.query<T>(sql, params, client);
    return rows[0] ?? null;
  }

  async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** Apply db/migrations/*.sql in order, once each, under an advisory lock (API and workers start together). */
  async migrate(): Promise<string[]> {
    const dir = [path.resolve(__dirname, '../migrations'), path.resolve(process.cwd(), '../../db/migrations'), path.resolve(process.cwd(), 'db/migrations')].find((d) => fs.existsSync(d));
    if (!dir) throw new Error('migrations directory not found');
    const client = await this.pool.connect();
    const applied: string[] = [];
    try {
      await client.query('SELECT pg_advisory_lock(727274)');
      await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
      const done = new Set((await client.query<{ version: string }>('SELECT version FROM schema_migrations')).rows.map((r) => r.version));
      for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
        if (done.has(file)) continue;
        const sql = fs.readFileSync(path.join(dir, file), 'utf8');
        await client.query('BEGIN');
        try {
          await client.query(sql);
          await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
          await client.query('COMMIT');
          applied.push(file);
        } catch (err) {
          await client.query('ROLLBACK');
          throw new Error(`migration ${file} failed: ${(err as Error).message}`);
        }
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock(727274)').catch(() => undefined);
      client.release();
    }
    if (applied.length) this.logger.log(`applied migrations: ${applied.join(', ')}`);
    return applied;
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
