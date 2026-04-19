import axios, { type AxiosInstance } from 'axios';
import { logger } from '../utils/logger';
import pool from '../db';

interface AmoCRMTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

interface AmoCRMLead {
  id: number;
  name: string;
  status_id: number;
  pipeline_id: number;
  responsible_user_id?: number;
}

interface AmoCRMContact {
  id: number;
  name: string;
  custom_fields_values?: Array<{
    field_code: string;
    values: Array<{ value: string }>;
  }>;
  _embedded?: { leads?: AmoCRMLead[] };
}

/**
 * Клиент AmoCRM REST API v4 с OAuth 2.0 и автообновлением токена
 */
export class AmoCRMClient {
  private http: AxiosInstance;
  private orgId: string;
  private domain: string;
  private clientId: string;
  private clientSecret: string;
  private accessToken: string;
  private refreshToken: string;
  private tokenExpiresAt: Date;

  constructor(opts: {
    orgId: string;
    domain: string;
    clientId: string;
    clientSecret: string;
    accessToken: string;
    refreshToken: string;
    tokenExpiresAt: Date;
  }) {
    this.orgId           = opts.orgId;
    this.domain          = opts.domain;
    this.clientId        = opts.clientId;
    this.clientSecret    = opts.clientSecret;
    this.accessToken     = opts.accessToken;
    this.refreshToken    = opts.refreshToken;
    this.tokenExpiresAt  = opts.tokenExpiresAt;

    this.http = axios.create({
      baseURL: `https://${this.domain}/api/v4`,
      timeout: 10000,
    });

    // Interceptor: добавляем Authorization header
    this.http.interceptors.request.use(async (reqConfig) => {
      await this.ensureTokenFresh();
      reqConfig.headers['Authorization'] = `Bearer ${this.accessToken}`;
      return reqConfig;
    });
  }

  /**
   * Найти лид по номеру телефона через контакт
   */
  async findLead(phone: string): Promise<AmoCRMLead | null> {
    try {
      const normalized = phone.replace(/\D/g, '');
      const resp = await this.http.get<{ _embedded: { contacts: AmoCRMContact[] } }>(
        `/contacts?query=${encodeURIComponent(normalized)}&with=leads`
      );
      const contacts = resp.data._embedded?.contacts ?? [];
      if (contacts.length === 0) return null;

      const leads = contacts[0]?._embedded?.leads ?? [];
      return leads[0] ?? null;
    } catch (err) {
      logger.error('AmoCRM: findLead failed', { error: err, phone });
      return null;
    }
  }

  /**
   * Создать новый лид с контактом
   */
  async createLead(
    name: string,
    phone: string,
    pipelineId: number,
    statusId: number
  ): Promise<number> {
    // 1. Создаём контакт
    const contactResp = await this.http.post<{ _embedded: { contacts: Array<{ id: number }> } }>(
      '/contacts',
      [{
        name,
        custom_fields_values: [{
          field_code: 'PHONE',
          values: [{ value: phone, enum_code: 'WORK' }],
        }],
      }]
    );
    const contactId = contactResp.data._embedded.contacts[0]!.id;

    // 2. Создаём лид и привязываем контакт
    const leadResp = await this.http.post<{ _embedded: { leads: Array<{ id: number }> } }>(
      '/leads',
      [{
        name:        `${name} — ${new Date().toLocaleDateString('ru-RU')}`,
        pipeline_id: pipelineId,
        status_id:   statusId,
        _embedded: {
          contacts: [{ id: contactId }],
        },
      }]
    );
    return leadResp.data._embedded.leads[0]!.id;
  }

  /**
   * Обновить этап лида в воронке
   */
  async updateLeadStage(leadId: number, statusId: number, note?: string): Promise<void> {
    await this.http.patch(`/leads/${leadId}`, { status_id: statusId });
    if (note) {
      await this.addNote(leadId, note);
    }
  }

  /**
   * Добавить заметку к лиду
   */
  async addNote(leadId: number, text: string): Promise<void> {
    await this.http.post('/leads/notes', [{
      entity_id:  leadId,
      note_type:  'common',
      params: { text },
    }]);
  }

  /**
   * OAuth 2.0: обновить access token через refresh token
   */
  private async refreshAccessToken(): Promise<void> {
    const resp = await axios.post<AmoCRMTokens>(
      `https://${this.domain}/oauth2/access_token`,
      {
        client_id:     this.clientId,
        client_secret: this.clientSecret,
        grant_type:    'refresh_token',
        refresh_token: this.refreshToken,
        redirect_uri:  `https://app.salesagent.ai/api/crm/amocrm/callback`,
      }
    );

    this.accessToken    = resp.data.access_token;
    this.refreshToken   = resp.data.refresh_token;
    this.tokenExpiresAt = new Date(Date.now() + resp.data.expires_in * 1000);

    // Сохраняем обновлённые токены в БД
    await pool.query(
      `UPDATE crm_connections
       SET access_token = $1, refresh_token = $2, token_expires_at = $3, updated_at = NOW()
       WHERE org_id = $4 AND crm_type = 'amocrm'`,
      [this.accessToken, this.refreshToken, this.tokenExpiresAt, this.orgId]
    );
    logger.info('AmoCRM: token refreshed', { orgId: this.orgId });
  }

  private async ensureTokenFresh(): Promise<void> {
    // Обновляем токен за 5 минут до истечения
    if (new Date(Date.now() + 5 * 60 * 1000) >= this.tokenExpiresAt) {
      await this.refreshAccessToken();
    }
  }
}

/**
 * Загрузить AmoCRM клиент для организации из БД
 */
export async function getAmoCRMClient(orgId: string): Promise<AmoCRMClient | null> {
  const result = await pool.query(
    `SELECT domain, access_token, refresh_token, token_expires_at
     FROM crm_connections
     WHERE org_id = $1 AND crm_type = 'amocrm' AND is_active = true`,
    [orgId]
  );
  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  return new AmoCRMClient({
    orgId,
    domain:        row.domain,
    clientId:      process.env['AMOCRM_CLIENT_ID'] ?? '',
    clientSecret:  process.env['AMOCRM_CLIENT_SECRET'] ?? '',
    accessToken:   row.access_token,
    refreshToken:  row.refresh_token,
    tokenExpiresAt: new Date(row.token_expires_at),
  });
}
