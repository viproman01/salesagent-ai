import axios from 'axios';

// В dev-режиме ходим напрямую на бэкенд (vite proxy капризничает в разных браузерах)
const API_BASE = (import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV
  ? 'http://127.0.0.1:3002/api/v1'
  : '/api/v1';

const api = axios.create({
  baseURL: API_BASE,
  headers: { 'Content-Type': 'application/json' },
});

// Добавляем JWT токен к каждому запросу
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// Перенаправляем на логин при 401
api.interceptors.response.use(
  (r) => r,
  (err) => {
    if (err.response?.status === 401) {
      localStorage.removeItem('token');
      window.location.href = '/login';
    }
    return Promise.reject(err);
  }
);

export default api;

// Типы данных
export interface Metric {
  totalConversations: number;
  totalLeads:         number;
  conversionRate:     number;
  avgResponseTimeMs:  number;
}

export interface FunnelItem { stage: string; count: string }
export interface TrendItem  { date: string; conversations: string }

export interface Conversation {
  id:            string;
  channel:       string;
  status:        string;
  message_count: number;
  duration_seconds: number | null;
  sentiment:     string | null;
  summary:       string | null;
  started_at:    string;
  last_message_at: string | null;
  phone:         string;
  lead_name:     string | null;
  lead_stage:    string;
  agent_name:    string | null;
}

export interface Message {
  id:            string;
  role:          string;
  content:       string | null;
  tool_name:     string | null;
  tool_input:    Record<string, unknown> | null;
  tool_result:   Record<string, unknown> | null;
  tokens_input:  number | null;
  tokens_output: number | null;
  latency_ms:    number | null;
  created_at:    string;
}

export interface Recording {
  id:               string;
  duration_seconds: number;
  quality_score:    number | null;
  created_at:       string;
  conversation_id:  string;
  channel:          string;
  started_at:       string;
  phone:            string | null;
  lead_name:        string | null;
}

export interface Agent {
  id:            string;
  name:          string;
  system_prompt: string;
  channels:      string[];
  voice_config:  { voice: string; language: string; speed: number };
  temperature:   number;
  max_tokens:    number;
  is_active:     boolean;
}
