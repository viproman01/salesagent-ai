/**
 * Redis connection factory.
 * When REDIS_URL=memory — возвращает ioredis-mock (без реального Redis).
 * Иначе — подключается к реальному Redis по URL.
 */

/* eslint-disable @typescript-eslint/no-require-imports */

import { config } from '../config';

let _connection: any = null;

export function getRedisConnection(): any {
  if (_connection) return _connection;

  if (config.REDIS_URL === 'memory') {
    const IORedisMock = require('ioredis-mock');
    _connection = new IORedisMock();
    return _connection;
  }

  const { Redis } = require('ioredis');
  _connection = new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
  return _connection;
}
