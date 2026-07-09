import nodemailer, { Transporter } from 'nodemailer';

export interface SendEmailOptions {
  from: string;
  to: string | string[];
  subject: string;
  html?: string;
  text?: string;
  cc?: string | string[];
  bcc?: string | string[];
  replyTo?: string;
}

export interface SendEmailResponse {
  data?: {
    id: string;
    messageId: string;
  };
  error?: {
    message: string;
    code?: string;
  };
}

interface SMTPConfig {
  host: string;
  port: number;
  secure: boolean;
}

/**
 * MailDrop - Simple email sending with pre-configured SMTP
 * 
 * Automatically detects SMTP settings based on email provider.
 * Supports Gmail, Outlook, Yahoo, and custom SMTP.
 */
export class MailDrop {
  private transporter: Transporter;
  private fromEmail: string;

  /**
   * Create a new MailDrop instance
   * 
   * @param email - Your email address (e.g., 'user@gmail.com')
   * @param password - Your email password or app-specific password
   * @param customSMTP - Optional custom SMTP configuration
   * 
   * @example
   * ```ts
   * // Gmail (requires app password)
   * const mail = new MailDrop('user@gmail.com', 'your-app-password');
   * 
   * // Outlook
   * const mail = new MailDrop('user@outlook.com', 'your-password');
   * 
   * // Custom SMTP
   * const mail = new MailDrop('user@example.com', 'password', {
   *   host: 'smtp.example.com',
   *   port: 587,
   *   secure: false
   * });
   * ```
   */
  constructor(
    email: string,
    password: string,
    customSMTP?: SMTPConfig
  ) {
    this.fromEmail = email;
    const smtpConfig = customSMTP || this.detectSMTPConfig(email);
    
    this.transporter = nodemailer.createTransport({
      host: smtpConfig.host,
      port: smtpConfig.port,
      secure: smtpConfig.secure,
      auth: {
        user: email,
        pass: password,
      },
    });
  }

  /**
   * Send an email
   * 
   * @param options - Email options
   * @returns Promise with data or error (Resend-like API)
   * 
   * @example
   * ```ts
   * const { data, error } = await mail.send({
   *   from: 'Your Name <your@email.com>',
   *   to: ['recipient@example.com'],
   *   subject: 'Hello World',
   *   html: '<strong>It works!</strong>',
   * });
   * 
   * if (error) {
   *   console.error(error);
   *   return;
   * }
   * 
   * console.log(data);
   * ```
   */
  async send(options: SendEmailOptions): Promise<SendEmailResponse> {
    try {
      // Normalize 'to' field to array
      const to = Array.isArray(options.to) ? options.to : [options.to];
      
      const info = await this.transporter.sendMail({
        from: options.from,
        to: to.join(', '),
        subject: options.subject,
        html: options.html,
        text: options.text,
        cc: options.cc ? (Array.isArray(options.cc) ? options.cc.join(', ') : options.cc) : undefined,
        bcc: options.bcc ? (Array.isArray(options.bcc) ? options.bcc.join(', ') : options.bcc) : undefined,
        replyTo: options.replyTo,
      });

      return {
        data: {
          id: info.messageId,
          messageId: info.messageId,
        },
      };
    } catch (error: any) {
      return {
        error: {
          message: error.message || 'Failed to send email',
          code: error.code,
        },
      };
    }
  }

  /**
   * Verify SMTP connection
   * 
   * @returns Promise<boolean> - true if connection is valid
   */
  async verify(): Promise<boolean> {
    try {
      await this.transporter.verify();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Detect SMTP configuration based on email domain
   */
  private detectSMTPConfig(email: string): SMTPConfig {
    const domain = email.split('@')[1]?.toLowerCase() || '';

    // Gmail
    if (domain === 'gmail.com' || domain === 'googlemail.com') {
      return {
        host: 'smtp.gmail.com',
        port: 587,
        secure: false, // Use TLS
      };
    }

    // Outlook / Hotmail / Live
    if (
      domain === 'outlook.com' ||
      domain === 'hotmail.com' ||
      domain === 'live.com' ||
      domain === 'msn.com'
    ) {
      return {
        host: 'smtp-mail.outlook.com',
        port: 587,
        secure: false, // Use TLS
      };
    }

    // Yahoo
    if (domain === 'yahoo.com' || domain === 'yahoo.co.uk' || domain === 'ymail.com') {
      return {
        host: 'smtp.mail.yahoo.com',
        port: 587,
        secure: false, // Use TLS
      };
    }

    // Zoho
    if (domain === 'zoho.com' || domain.endsWith('.zoho.com')) {
      return {
        host: 'smtp.zoho.com',
        port: 587,
        secure: false,
      };
    }

    // ProtonMail
    if (domain === 'protonmail.com' || domain === 'proton.me') {
      return {
        host: '127.0.0.1',
        port: 1025,
        secure: false,
      };
    }

    // Default: Try common SMTP settings
    // Users should provide customSMTP for other providers
    return {
      host: 'smtp.gmail.com',
      port: 587,
      secure: false,
    };
  }
}

/**
 * Drop an email using environment variables (SIMPLEST WAY!)
 * 
 * Reads credentials from environment variables:
 * - MAILDROP_EMAIL (required)
 * - MAILDROP_PASSWORD (required)
 * 
 * @param options - Email options (from is optional, defaults to MAILDROP_EMAIL)
 * @returns Promise with data or error
 * 
 * @example
 * ```ts
 * // Set env vars: MAILDROP_EMAIL and MAILDROP_PASSWORD
 * const { data, error } = await drop({
 *   to: 'recipient@example.com',
 *   subject: 'Hello',
 *   html: '<p>Hello!</p>',
 * });
 * ```
 */
export async function drop(
  options: Omit<SendEmailOptions, 'from'> & { from?: string }
): Promise<SendEmailResponse> {
  const email = process.env.MAILDROP_EMAIL;
  const password = process.env.MAILDROP_PASSWORD;

  if (!email || !password) {
    return {
      error: {
        message: 'MAILDROP_EMAIL and MAILDROP_PASSWORD environment variables are required',
        code: 'MISSING_CREDENTIALS',
      },
    };
  }

  const mail = new MailDrop(email, password);
  
  return mail.send({
    ...options,
    from: options.from || email,
  });
}

/**
 * Quick drop function - no class instantiation needed
 * 
 * @param email - Your email address
 * @param password - Your email password/app-password
 * @param options - Email options (from is optional, defaults to email)
 * 
 * @example
 * ```ts
 * const { data, error } = await quickDrop(
 *   'user@gmail.com',
 *   'app-password',
 *   {
 *     to: 'recipient@example.com',
 *     subject: 'Hello',
 *     html: '<p>Hello!</p>',
 *   }
 * );
 * ```
 */
export async function quickDrop(
  email: string,
  password: string,
  options: Omit<SendEmailOptions, 'from'> & { from?: string }
): Promise<SendEmailResponse> {
  const mail = new MailDrop(email, password);
  
  return mail.send({
    ...options,
    from: options.from || email,
  });
}

// Default export
export default MailDrop;

