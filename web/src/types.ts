export interface Me {
  authenticated: boolean;
  defaultPassword?: boolean;
  smtpConfigured?: boolean;
  turnstileConfigured?: boolean;
  /** Firebase credentials saved and at least one phone connected. */
  smsConfigured?: boolean;
}

export interface Form {
  id: string;
  name: string;
  slug: string;
  destination_email: string;
  destination_emails: string[];
  subject_template: string;
  allowed_origins: string[];
  redirect_url: string | null;
  api_key_prefix: string;
  enabled: boolean;
  created_at: string;
  endpoint: string;
  turnstile_enabled: boolean;
  turnstile_configured: boolean;
  turnstile_site_key: string | null;
  spam_score_threshold: number;
  sms_enabled: boolean;
  sms_number: string | null;
  sms_template: string;
  sms_device_id: string | null;
}

export interface FormInput {
  name: string;
  slug?: string;
  destination_emails: string[];
  subject_template?: string;
  allowed_origins?: string[];
  redirect_url?: string;
  enabled?: boolean;
  turnstile_enabled?: boolean;
  spam_score_threshold?: number;
  sms_enabled?: boolean;
  sms_number?: string;
  sms_template?: string;
  sms_device_id?: string | null;
}

export interface SmsSettings {
  firebase_configured: boolean;
  firebase_error: string | null;
  firebase_project_id: string | null;
  firebase_client_email: string | null;
  default_country_code: string;
  max_length: number;
  devices_registered: number;
  ready: boolean;
}

export interface SmsDevice {
  id: string;
  name: string;
  api_key_prefix: string;
  registered: boolean;
  connected: boolean;
  enabled: boolean;
  is_default: boolean;
  brand: string | null;
  manufacturer: string | null;
  model: string | null;
  os_version: string | null;
  app_version_name: string | null;
  registered_at: string | null;
  last_seen_at: string | null;
  created_at: string;
}

export type SmsDirection = 'outbound' | 'inbound';

export interface SmsMessage {
  id: string;
  device_id: string | null;
  device_name: string | null;
  direction: SmsDirection;
  recipient: string | null;
  sender: string | null;
  message: string;
  status: string;
  error_code: string | null;
  error_message: string | null;
  form_id: string | null;
  form_name: string | null;
  submission_id: string | null;
  requested_at: string | null;
  sent_at: string | null;
  delivered_at: string | null;
  failed_at: string | null;
  received_at: string | null;
  created_at: string;
}

export interface SmsMessagesResponse {
  messages: SmsMessage[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface Settings {
  smtp_email: string;
  smtp_password_set: boolean;
  smtp_host: string;
  smtp_port: string | number;
  smtp_secure: boolean;
  from_email: string;
  from_name: string;
}

export type SubmissionStatus = 'sent' | 'failed' | 'spam' | 'rate_limited';

export interface SpamReason {
  code: string;
  points: number;
  detail: string;
}

export interface Submission {
  id: string;
  form_id: string;
  payload: unknown;
  reply_to: string | null;
  status: SubmissionStatus;
  error: string | null;
  message_id: string | null;
  ip: string | null;
  spam_score: number;
  spam_reasons: SpamReason[];
  turnstile_status: string | null;
  sms_status: string | null;
  sms_error: string | null;
  sms_message_id: string | null;
  created_at: string;
}

export interface SubmissionsResponse {
  submissions: Submission[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface PerFormStat {
  form_id: string;
  form_name: string;
  slug: string;
  sent: number | null;
  failed: number | null;
  spam: number | null;
  total: number;
}

export interface Stats {
  last24h: { sent: number; failed: number; spam: number };
  last30d: { sent: number; failed: number; spam: number };
  perForm: PerFormStat[];
}
