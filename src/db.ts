import mysql, { type PoolConnection, type ResultSetHeader, type RowDataPacket } from 'mysql2/promise';
import { config } from './config';

export interface QueryResult<T> { rows: T[]; affectedRows: number; insertId: number; }

type Params = readonly unknown[];
const jsonColumns = new Set(['metadata', 'persona', 'channels', 'voice_config', 'classification', 'tool_input', 'tool_result', 'highlights', 'stage_mapping', 'tags', 'top_objections', 'response_json']);

function hydrateRows<T>(rows: T[]): T[] {
  return rows.map(row => {
    if (!row || typeof row !== 'object') return row;
    const copy = { ...(row as Record<string, unknown>) };
    for (const key of jsonColumns) {
      if (typeof copy[key] === 'string') {
        try { copy[key] = JSON.parse(copy[key] as string); } catch { /* preserve malformed legacy value */ }
      }
    }
    return copy as T;
  });
}

export function compileSql(statement: string, values: Params = []): { statement: string; values: unknown[] } {
  const orderedValues: unknown[] = [];
  const compiledStatement = statement
    .replace(/\$(\d+)(?:::[a-z_]+)?/gi, (_match, rawIndex: string) => {
      const index = Number(rawIndex) - 1;
      if (index < 0 || index >= values.length) {
        throw new Error(`Missing SQL parameter $${rawIndex}`);
      }
      orderedValues.push(values[index]);
      return '?';
    })
    .replace(/NOW\(\)/gi, 'CURRENT_TIMESTAMP');
  return { statement: compiledStatement, values: orderedValues };
}

class MysqlClient {
  constructor(private readonly connection: PoolConnection) {}
  async query<T = RowDataPacket>(statement: string, values: Params = []): Promise<QueryResult<T>> {
    const compiled = compileSql(statement, values);
    const [result] = await this.connection.query(compiled.statement, compiled.values);
    if (Array.isArray(result)) return { rows: hydrateRows(result as T[]), affectedRows: 0, insertId: 0 };
    const header = result as ResultSetHeader;
    return { rows: [], affectedRows: header.affectedRows, insertId: header.insertId };
  }
  async beginTransaction(): Promise<void> { await this.connection.beginTransaction(); }
  async commit(): Promise<void> { await this.connection.commit(); }
  async rollback(): Promise<void> { await this.connection.rollback(); }
  release(): void { this.connection.release(); }
}

const pool = mysql.createPool({
  uri: config.MYSQL_URL,
  waitForConnections: true,
  connectionLimit: 10,
  enableKeepAlive: true,
  decimalNumbers: true,
});

async function query<T = RowDataPacket>(statement: string, values: Params = []): Promise<QueryResult<T>> {
  const compiled = compileSql(statement, values);
  const [result] = await pool.query(compiled.statement, compiled.values);
  if (Array.isArray(result)) return { rows: hydrateRows(result as T[]), affectedRows: 0, insertId: 0 };
  const header = result as ResultSetHeader;
  return { rows: [], affectedRows: header.affectedRows, insertId: header.insertId };
}

async function connect(): Promise<MysqlClient> { return new MysqlClient(await pool.getConnection()); }

export default { query, connect };

export async function testConnection(): Promise<void> {
  await query('SELECT 1');
}

export async function closeDb(): Promise<void> {
  await pool.end();
}
