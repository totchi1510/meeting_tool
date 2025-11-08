import fs from 'fs';
import path from 'path';
import { withClient } from './db';

export async function migrateIfPossible(): Promise<void> {
  // Skip if no DB configured
  if (!process.env.DATABASE_URL) {
    console.warn('[db] DATABASE_URL not set; skipping migrations');
    return;
  }

  const dir = path.join(process.cwd(), 'migrations');
  if (!fs.existsSync(dir)) {
    console.warn('[db] migrations directory not found; skipping');
    return;
  }

  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  if (files.length === 0) {
    console.log('[db] no migration files to apply');
    return;
  }

  await withClient(async (c) => {
    await c.query(
      `create table if not exists migrations (name text primary key, applied_at timestamptz default now())`
    );

    for (const file of files) {
      const { rows } = await c.query<{ name: string }>('select name from migrations where name = $1', [file]);
      if (rows.length) {
        continue; // already applied
      }

      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      console.log(`[db] applying migration ${file}`);
      try {
        await c.query('begin');
        await c.query(sql);
        await c.query('insert into migrations(name) values ($1)', [file]);
        await c.query('commit');
      } catch (err) {
        await c.query('rollback');
        console.error(`[db] migration failed: ${file}`, err);
        throw err;
      }
    }
  });
}

