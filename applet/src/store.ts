import { hostCall, type QueryResult, type SqlValue } from '../vendor/apell-sdk';

type SqlParameter = string | number | null;
const parameter = (value: SqlParameter): SqlValue => value === null ? { type: 'null' }
  : typeof value === 'number' ? { type: 'integer', value: String(value) } : { type: 'text', value };

/** Serialize short transactions; network and model requests must run outside this queue. */
export class Store {
  private tail: Promise<unknown> = Promise.resolve();
  private database_handle = '';
  private transaction_handle: string | undefined;
  private initialized = false;

  async transaction<T>(operation: (store: Store) => Promise<T>): Promise<T> {
    const run = this.tail.then(async () => {
      if (!this.initialized) await this.initialize();
      const opened = await hostCall<{ transaction_handle: string }>('sqlite.begin', { database_handle: this.database_handle });
      this.transaction_handle = opened.transaction_handle;
      try {
        const value = await operation(this);
        await hostCall('sqlite.commit', this.handles());
        return value;
      } catch (error) {
        await hostCall('sqlite.rollback', this.handles()).catch(() => {});
        throw error;
      } finally { this.transaction_handle = undefined; }
    });
    this.tail = run.catch(() => {});
    return run;
  }

  private handles(): Record<string, string> {
    return { database_handle: this.database_handle,
      ...(this.transaction_handle ? { transaction_handle: this.transaction_handle } : {}) };
  }

  private async initialize(): Promise<void> {
    const opened = await hostCall<{ database_handle: string }>('sqlite.open', { database_name: 'doi' });
    this.database_handle = opened.database_handle;
    const version = await this.query('PRAGMA user_version');
    if (Number(version.rows[0]?.[0] && 'value' in version.rows[0][0] ? version.rows[0][0].value : 0) > 1) {
      throw new Error('This library requires a newer Paper Reader applet.');
    }
    await this.execute('CREATE TABLE IF NOT EXISTS documents (kind TEXT NOT NULL, id TEXT NOT NULL, paper_id TEXT NOT NULL, PRIMARY KEY(kind,id))');
    await this.execute('CREATE INDEX IF NOT EXISTS documents_by_paper ON documents(kind,paper_id,id)');
    await this.execute('CREATE TABLE IF NOT EXISTS document_chunks (kind TEXT NOT NULL, id TEXT NOT NULL, part INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(kind,id,part), FOREIGN KEY(kind,id) REFERENCES documents(kind,id) ON DELETE CASCADE)');
    await this.execute('PRAGMA user_version = 1');
    this.initialized = true;
  }

  async query(sql: string, values: SqlParameter[] = []): Promise<QueryResult> {
    return hostCall('sqlite.query', { ...this.handles(), sql, parameters: values.map(parameter) });
  }

  async execute(sql: string, values: SqlParameter[] = []): Promise<void> {
    await hostCall('sqlite.execute', { ...this.handles(), sql, parameters: values.map(parameter) });
  }

  async get<T>(kind: string, id: string): Promise<T | null> {
    let text = '';
    for (let offset = 0; ; offset += 8) {
      const result = await this.query('SELECT data FROM document_chunks WHERE kind=? AND id=? ORDER BY part LIMIT 8 OFFSET ?', [kind, id, offset]);
      for (const row of result.rows) {
        if (row[0].type !== 'text') throw new Error('The library contains an invalid record.');
        text += row[0].value;
      }
      if (result.rows.length < 8) break;
    }
    return text ? JSON.parse(text) as T : null;
  }

  async put(kind: string, id: string, paper_id: string, value: unknown): Promise<void> {
    const text = JSON.stringify(value);
    if (new TextEncoder().encode(text).byteLength > 16 * 1024 * 1024) throw new Error('The record exceeds the library size limit.');
    await this.remove(kind, id);
    await this.execute('INSERT INTO documents(kind,id,paper_id) VALUES(?,?,?)', [kind, id, paper_id]);
    // Split on Unicode code points so SQLite never receives an unpaired surrogate.
    const points = Array.from(text);
    for (let offset = 0; offset < points.length; offset += 32768) {
      await this.execute('INSERT INTO document_chunks(kind,id,part,data) VALUES(?,?,?,?)',
        [kind, id, offset / 32768, points.slice(offset, offset + 32768).join('')]);
    }
  }

  async list<T>(kind: string, paper_id?: string): Promise<T[]> {
    const values: T[] = [];
    for (let offset = 0; ; offset += 100) {
      const result = await this.query(`SELECT id FROM documents WHERE kind=?${paper_id === undefined ? '' : ' AND paper_id=?'} ORDER BY id LIMIT 100 OFFSET ?`,
        paper_id === undefined ? [kind, offset] : [kind, paper_id, offset]);
      for (const row of result.rows) {
        if (row[0].type !== 'text') throw new Error('Invalid library record ID.');
        const value = await this.get<T>(kind, row[0].value);
        if (value !== null) values.push(value);
      }
      if (result.rows.length < 100) return values;
    }
  }

  async remove(kind: string, id: string): Promise<void> {
    await this.execute('DELETE FROM documents WHERE kind=? AND id=?', [kind, id]);
  }
}

export const store = new Store();
