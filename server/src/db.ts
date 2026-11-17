import { Pool, type PoolClient } from 'pg'
import { config } from './config'

export const pool = new Pool({ connectionString: config.DATABASE_URL, max: 10 })

export function query<T extends import('pg').QueryResultRow = import('pg').QueryResultRow>(
  text: string,
  params?: unknown[]
) {
  return pool.query<T>(text, params)
}

// Транзакция: fn получает клиент с уже открытой транзакцией, откат при исключении.
export async function tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('begin')
    const out = await fn(client)
    await client.query('commit')
    return out
  } catch (e) {
    await client.query('rollback')
    throw e
  } finally {
    client.release()
  }
}
