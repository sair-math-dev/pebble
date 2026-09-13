import { readFile } from 'node:fs/promises';
import pg, { type PoolClient } from 'pg';

export class Database {
  readonly pool: pg.Pool;
  constructor(connectionString: string) {
    const configuredSize = process.env.DB_POOL_SIZE ?? '12';
    if (!/^[1-9][0-9]?$|^100$/.test(configuredSize)) throw new Error('DB_POOL_SIZE must be an integer between 1 and 100');
    this.pool = new pg.Pool({ connectionString, max: Number(configuredSize), connectionTimeoutMillis: 10_000 });
  }

  async transaction<T>(fn: (db: PoolClient) => Promise<T>, write = true): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const db = await this.pool.connect();
      try {
        await db.query(write ? 'BEGIN ISOLATION LEVEL SERIALIZABLE' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const result = await fn(db);
        await db.query('COMMIT');
        return result;
      } catch (error) {
        await db.query('ROLLBACK');
        if (attempt >= 5 || !['40001', '40P01'].includes((error as {code?: string}).code ?? '')) throw error;
      } finally {
        db.release();
      }
      await new Promise(resolve => setTimeout(resolve, 10 + Math.random() * (20 << attempt)));
    }
  }

  async migrate() {
    const migrations = await Promise.all(['001_registry.sql', '002_invitations.sql'].map(name =>
      readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8')));
    await this.transaction(async db => {
      // Only schema installation is serialized globally; ordinary requests and
      // independent packages use PostgreSQL SERIALIZABLE transactions.
      await db.query('SELECT pg_advisory_xact_lock(721842501)');
      for (const sql of migrations) await db.query(sql);
    });
  }

  async close() { await this.pool.end(); }
}
