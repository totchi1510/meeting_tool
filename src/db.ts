import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;

let pool: Pool | null = null;

export function getPool(): Pool | null {
  if (!DATABASE_URL) return null;
  if (pool) return pool;

  const useSSL = /neon\.tech|render\.com|supabase\.co|herokuapp\.com/i.test(DATABASE_URL);
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: useSSL ? { rejectUnauthorized: false } : undefined,
    max: 5,
    idleTimeoutMillis: 30_000,
  });
  return pool;
}

export async function withClient<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const p = getPool();
  if (!p) throw new Error('DATABASE_URL not set');
  const client = await p.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

export async function query<T extends QueryResultRow = QueryResultRow>(text: string, params?: any[]): Promise<QueryResult<T>> {
  const p = getPool();
  if (!p) throw new Error('DATABASE_URL not set');
  return p.query<T>(text, params);
}
