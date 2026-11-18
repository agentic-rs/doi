import type { DatabaseSync } from 'node:sqlite';
import type { SqlValue } from '../vendor/apell-sdk/types';

export function sqliteCall(database: DatabaseSync, method: string, params: Record<string, unknown>) {
  if (method === 'sqlite.open') return { database_handle: 'database' };
  if (method === 'sqlite.begin') { database.exec('BEGIN IMMEDIATE'); return { transaction_handle: 'transaction' }; }
  if (method === 'sqlite.commit') { database.exec('COMMIT'); return null; }
  if (method === 'sqlite.rollback') { database.exec('ROLLBACK'); return null; }
  if (method !== 'sqlite.execute' && method !== 'sqlite.query') throw new Error(`Unexpected method ${method}`);
  const statement = database.prepare(String(params.sql));
  const values = (params.parameters as SqlValue[]).map((value) => value.type === 'null' ? null
    : value.type === 'integer' ? BigInt(value.value)
    : value.type === 'blob' ? Uint8Array.from(value.value) : value.value);
  if (method === 'sqlite.execute') { statement.run(...values); return { affected_rows: 1, last_insert_row_id: '0' }; }
  return {
    columns: statement.columns().map((column) => column.name),
    rows: statement.all(...values).map((row) => Object.values(row).map((value) =>
      value === null ? { type: 'null' } : typeof value === 'number' ? { type: 'integer', value: String(value) } : { type: 'text', value })),
  };
}
