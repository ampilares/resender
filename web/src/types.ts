export interface Me {
  authenticated: boolean;
  defaultPassword?: boolean;
  smtpConfigured?: boolean;
}

export interface Form {
  id: string;
  name: string;
  slug: string;
  destination_email: string;
  subject_template: string;
  allowed_origins: string[];
  redirect_url: string | null;
  api_key_prefix: string;
  enabled: boolean;
  created_at: string;
  endpoint: string;
}

export interface FormInput {
  name: string;
  slug?: string;
  destination_email: string;
  subject_template?: string;
  allowed_origins?: string[];
  redirect_url?: string;
  enabled?: boolean;
}

export interface Settings {
  smtp_email: string;
  smtp_password_set: boolean;
  smtp_host: string;
  smtp_port: string | number;
  smtp_secure: boolean;
  from_name: string;
}

export type SubmissionStatus = 'sent' | 'failed' | 'spam' | 'rate_limited';

export interface Submission {
  id: string;
  form_id: string;
  payload: unknown;
  reply_to: string | null;
  status: SubmissionStatus;
  error: string | null;
  message_id: string | null;
  ip: string | null;
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
