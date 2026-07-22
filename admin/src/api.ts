import axios from 'axios';

type AdminImportMeta = ImportMeta & {
  env?: {
    DEV?: boolean;
    VITE_API_BASE_URL?: string;
  };
};

const adminEnv = (import.meta as AdminImportMeta).env;
const configuredApiBase = adminEnv?.VITE_API_BASE_URL?.trim().replace(/\/$/, '');

// VITE_API_BASE_URL accepts a complete API prefix, for example
// http://127.0.0.1:3000/api/v1. Port 3000 matches the documented backend default.
const API_BASE = configuredApiBase || (adminEnv?.DEV
  ? 'http://127.0.0.1:3000/api/v1'
  : '/api/v1');

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
  phone:         string | null;
  lead_name:     string | null;
  lead_stage:    string | null;
  agent_name:    string | null;
  reply_mode:    'ai' | 'operator';
  mode_version:  number;
  whatsapp_opted_out: boolean;
  whatsapp_handoff: boolean;
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
  sender_type:   'customer' | 'ai' | 'operator' | 'system';
  author_user_id: string | null;
  delivery_status: 'received' | 'pending' | 'sending' | 'sent' | 'failed' | 'cancelled' | 'not_applicable';
  external_id: string | null;
  provider_message_id: string | null;
  sequence_id: number;
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
