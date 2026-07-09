# maildrop

Simple email sending with pre-configured SMTP - no setup required! 🚀

A lightweight wrapper around Nodemailer that automatically detects SMTP settings based on your email provider. Perfect for when you want Resend-like simplicity but need to use free SMTP services.

## Features

- ✨ **Zero Configuration** - Auto-detects SMTP settings for Gmail, Outlook, Yahoo, and more
- 🎯 **Resend-like API** - Familiar interface if you've used Resend
- 📦 **Lightweight** - Just a thin wrapper around Nodemailer
- 🔒 **TypeScript** - Full TypeScript support
- 🆓 **Free** - Uses your existing email account

## Installation

```bash
npm install maildrop
```

## Quick Start

### Method 1: Using Environment Variables (SIMPLEST! 🎯)

```typescript
import { drop } from 'maildrop';

// Set environment variables:
// MAILDROP_EMAIL=your-email@gmail.com
// MAILDROP_PASSWORD=your-app-password

const { data, error } = await drop({
  to: 'recipient@example.com',
  subject: 'Hello World',
  html: '<strong>It works!</strong>',
});

if (error) {
  return console.error({ error });
}

console.log({ data });
```

### Method 2: Quick Drop Function (No Class!)

```typescript
import { quickDrop } from 'maildrop';

const { data, error } = await quickDrop(
  'your-email@gmail.com',
  'your-app-password',
  {
    to: 'recipient@example.com',
    subject: 'Hello World',
    html: '<strong>It works!</strong>',
  }
);
```

### Method 3: Class-Based (Original API)

```typescript
import { MailDrop } from 'maildrop';

const mail = new MailDrop('your-email@gmail.com', 'your-app-password');

const { data, error } = await mail.send({
  from: 'Your Name <your-email@gmail.com>',
  to: ['recipient@example.com'],
  subject: 'Hello World',
  html: '<strong>It works!</strong>',
});
```

## Supported Providers

The following email providers are automatically detected:

- ✅ **Gmail** (`gmail.com`, `googlemail.com`)
- ✅ **Outlook** (`outlook.com`, `hotmail.com`, `live.com`, `msn.com`)
- ✅ **Yahoo** (`yahoo.com`, `yahoo.co.uk`, `ymail.com`)
- ✅ **Zoho** (`zoho.com`, `*.zoho.com`)
- ✅ **Custom SMTP** (see below)

## Usage Examples

### Simplest: Environment Variables

Create a `.env` file:
```env
MAILDROP_EMAIL=your-email@gmail.com
MAILDROP_PASSWORD=your-app-password
```

Then use:
```typescript
import { drop } from 'maildrop';

// 'from' is optional - defaults to MAILDROP_EMAIL
const { data, error } = await drop({
  to: 'recipient@example.com',
  subject: 'Hello',
  html: '<p>Hello!</p>',
});
```

### Gmail

**Important:** Gmail requires an [App Password](https://support.google.com/accounts/answer/185833) instead of your regular password.

1. Enable 2-Step Verification on your Google Account
2. Generate an App Password: [Google Account Settings](https://myaccount.google.com/apppasswords)
3. Use the generated app password (16 characters, no spaces)

```typescript
import { MailDrop } from 'maildrop';

const mail = new MailDrop('your-email@gmail.com', 'your-16-char-app-password');

const { data, error } = await mail.send({
  from: 'Your Name <your-email@gmail.com>',
  to: 'recipient@example.com',
  subject: 'Hello from Gmail!',
  html: '<p>This email was sent using Gmail SMTP.</p>',
});
```

### Outlook / Hotmail

```typescript
const mail = new MailDrop('your-email@outlook.com', 'your-password');

const { data, error } = await mail.send({
  from: 'Your Name <your-email@outlook.com>',
  to: ['recipient@example.com'],
  subject: 'Hello from Outlook!',
  html: '<p>This email was sent using Outlook SMTP.</p>',
});
```

### Custom SMTP

For providers not automatically detected, you can provide custom SMTP settings:

```typescript
const mail = new MailDrop(
  'user@example.com',
  'password',
  {
    host: 'smtp.example.com',
    port: 587,
    secure: false, // true for 465, false for other ports
  }
);
```

### Multiple Recipients

```typescript
const { data, error } = await mail.send({
  from: 'sender@example.com',
  to: ['recipient1@example.com', 'recipient2@example.com'],
  cc: ['cc@example.com'],
  bcc: ['bcc@example.com'],
  subject: 'Hello',
  html: '<p>Hello everyone!</p>',
});
```

### Text and HTML

```typescript
const { data, error } = await mail.send({
  from: 'sender@example.com',
  to: 'recipient@example.com',
  subject: 'Hello',
  text: 'Plain text version',
  html: '<p>HTML version</p>',
});
```

### Verify Connection

Test your SMTP connection before sending:

```typescript
const mail = new MailDrop('your-email@gmail.com', 'your-password');

const isValid = await mail.verify();
if (isValid) {
  console.log('SMTP connection is valid!');
} else {
  console.error('SMTP connection failed. Check your credentials.');
}
```

## API Reference

### `drop()` - Simplest Method! ⭐

Drop an email using environment variables. No credentials needed in code!

```typescript
drop(options: Omit<SendEmailOptions, 'from'> & { from?: string }): Promise<SendEmailResponse>
```

**Environment Variables Required:**
- `MAILDROP_EMAIL` - Your email address
- `MAILDROP_PASSWORD` - Your email password/app-password

**Options:**
- `to` (string | string[]) - Recipient email address(es) - **required**
- `subject` (string) - Email subject - **required**
- `html` (string, optional) - HTML content
- `text` (string, optional) - Plain text content
- `from` (string, optional) - Sender email address (defaults to `MAILDROP_EMAIL`)
- `cc` (string | string[], optional) - CC recipients
- `bcc` (string | string[], optional) - BCC recipients
- `replyTo` (string, optional) - Reply-to address

**Example:**
```typescript
import { drop } from 'maildrop';

const { data, error } = await drop({
  to: 'recipient@example.com',
  subject: 'Hello',
  html: '<p>Hello!</p>',
});
```

---

### `quickDrop()` - One-Liner Function

Drop an email without class instantiation.

```typescript
quickDrop(email: string, password: string, options: Omit<SendEmailOptions, 'from'> & { from?: string }): Promise<SendEmailResponse>
```

**Parameters:**
- `email` - Your email address
- `password` - Your email password/app-password
- `options` - Email options (same as `drop`, `from` defaults to `email`)

**Example:**
```typescript
import { quickDrop } from 'maildrop';

const { data, error } = await quickDrop(
  'user@gmail.com',
  'app-password',
  {
    to: 'recipient@example.com',
    subject: 'Hello',
    html: '<p>Hello!</p>',
  }
);
```

---

### `MailDrop` - Class-Based API

#### Constructor

```typescript
new MailDrop(email: string, password: string, customSMTP?: SMTPConfig)
```

- `email` - Your email address
- `password` - Your email password or app-specific password
- `customSMTP` - Optional custom SMTP configuration

#### Methods

##### `send(options: SendEmailOptions): Promise<SendEmailResponse>`

Send an email.

**Options:**
- `from` (string) - Sender email address
- `to` (string | string[]) - Recipient email address(es)
- `subject` (string) - Email subject
- `html` (string, optional) - HTML content
- `text` (string, optional) - Plain text content
- `cc` (string | string[], optional) - CC recipients
- `bcc` (string | string[], optional) - BCC recipients
- `replyTo` (string, optional) - Reply-to address

**Returns:**
```typescript
{
  data?: {
    id: string;
    messageId: string;
  };
  error?: {
    message: string;
    code?: string;
  };
}
```

##### `verify(): Promise<boolean>`

Verify SMTP connection. Returns `true` if connection is valid.

## Bulk Email Sending

maildrop supports sending to multiple recipients in a single call. You can use arrays for `to`, `cc`, and `bcc` fields:

```typescript
const { data, error } = await drop({
  to: ['user1@example.com', 'user2@example.com', 'user3@example.com'],
  subject: 'Newsletter',
  html: '<p>Hello everyone!</p>',
});
```

### Best Practices for Bulk Sending

**For small batches (< 50 emails):**
- Use arrays directly in `to`, `cc`, or `bcc`
- All recipients will see each other's addresses (use `bcc` for privacy)

**For larger batches (> 50 emails):**
- Use `bcc` to hide recipient addresses from each other
- Consider sending in smaller batches with delays to avoid rate limits
- Use a queue system for production applications

```typescript
// Good: Use BCC for privacy
const { data, error } = await drop({
  to: 'your-email@example.com', // Your address in 'to'
  bcc: ['user1@example.com', 'user2@example.com', /* ... many more */],
  subject: 'Newsletter',
  html: '<p>Hello!</p>',
});

// Better: Send in batches for large lists
const recipients = [/* large array */];
const batchSize = 50;

for (let i = 0; i < recipients.length; i += batchSize) {
  const batch = recipients.slice(i, i + batchSize);
  await drop({
    bcc: batch,
    subject: 'Newsletter',
    html: '<p>Hello!</p>',
  });
  
  // Small delay to avoid rate limits
  await new Promise(resolve => setTimeout(resolve, 1000));
}
```

**Rate Limits:**
- **Gmail**: ~500 emails/day for free accounts, ~2000/day for Google Workspace
- **Outlook**: ~300 emails/day for free accounts
- **Yahoo**: ~500 emails/day

For production bulk email, consider using dedicated email services (SendGrid, Mailgun, etc.) or upgrade to a business email account.

## Advanced Custom SMTP Configuration

For custom SMTP servers, you can provide additional configuration options:

```typescript
const mail = new MailDrop(
  'user@example.com',
  'password',
  {
    host: 'smtp.example.com',
    port: 587,        // 587 for TLS, 465 for SSL
    secure: false,     // true for SSL (port 465), false for TLS (port 587)
  }
);
```

### Common SMTP Ports

- **587** - TLS (STARTTLS) - Most common, recommended
- **465** - SSL - Legacy but still widely used
- **25** - Unencrypted - Not recommended, often blocked
- **2525** - Alternative TLS port (some providers)

### Enterprise SMTP Providers

Many enterprise email providers use custom SMTP settings:

```typescript
// Example: Custom corporate email
const mail = new MailDrop(
  'user@company.com',
  'password',
  {
    host: 'mail.company.com',  // Your company's mail server
    port: 587,
    secure: false,
  }
);
```

**Note:** maildrop uses Nodemailer under the hood, so you can access the full Nodemailer API if needed by accessing the transporter directly (though this requires modifying the source code).

## Error Handling

Always check for errors:

```typescript
const { data, error } = await mail.send({
  from: 'sender@example.com',
  to: 'recipient@example.com',
  subject: 'Hello',
  html: '<p>Hello</p>',
});

if (error) {
  console.error('Failed to send email:', error.message);
  // Handle error
  return;
}

console.log('Email sent successfully:', data.messageId);
```

### Handling Bulk Send Errors

When sending to multiple recipients, handle errors gracefully:

```typescript
const recipients = ['user1@example.com', 'user2@example.com', 'user3@example.com'];
const results = [];

for (const recipient of recipients) {
  const { data, error } = await drop({
    to: recipient,
    subject: 'Hello',
    html: '<p>Hello!</p>',
  });
  
  if (error) {
    console.error(`Failed to send to ${recipient}:`, error.message);
    results.push({ recipient, success: false, error: error.message });
  } else {
    results.push({ recipient, success: true, messageId: data?.messageId });
  }
}

console.log(`Sent ${results.filter(r => r.success).length}/${recipients.length} emails`);
```

## Common Issues

### Gmail: "Username and Password not accepted"

- Make sure you're using an **App Password**, not your regular Gmail password
- Enable 2-Step Verification first
- Generate a new App Password if needed

### Outlook: Authentication failed

- Make sure you're using your full email address as the username
- Some accounts may require enabling "Less secure app access" (not recommended)
- Consider using an App Password instead

### Connection timeout

- Check your firewall settings
- Verify the SMTP port (587 for TLS, 465 for SSL)
- Some networks block SMTP ports

### Rate limiting / Account suspension

- Free email accounts have daily sending limits
- Sending too many emails too quickly can trigger spam filters
- If your account gets suspended, wait 24 hours before trying again
- For production, consider using a dedicated email service

## Production Best Practices

### Environment Variables

Always use environment variables for credentials in production:

```typescript
// ✅ Good: Using environment variables
const { data, error } = await drop({
  to: process.env.ADMIN_EMAIL,
  subject: 'System Alert',
  html: '<p>Alert message</p>',
});

// ❌ Bad: Hardcoded credentials
const { data, error } = await quickDrop(
  'my-email@gmail.com',
  'my-password', // Never do this!
  { /* ... */ }
);
```

### Error Handling & Retries

Implement retry logic for production applications:

```typescript
async function sendWithRetry(options: SendEmailOptions, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const { data, error } = await drop(options);
    
    if (!error) {
      return { data, error: null };
    }
    
    // Don't retry on authentication errors
    if (error.code === 'EAUTH' || error.message.includes('password')) {
      return { data: null, error };
    }
    
    // Wait before retrying (exponential backoff)
    if (attempt < maxRetries) {
      await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
    }
  }
  
  return { data: null, error: { message: 'Max retries exceeded' } };
}
```

### Queue System for High Volume

For applications sending many emails, use a queue system:

```typescript
// Example using a simple queue
const emailQueue: Array<SendEmailOptions> = [];

async function processQueue() {
  while (emailQueue.length > 0) {
    const email = emailQueue.shift();
    if (email) {
      const { error } = await drop(email);
      if (error) {
        console.error('Failed to send:', error);
        // Add to retry queue or log for manual review
      }
      // Rate limiting: wait between sends
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}
```

### Monitoring & Logging

Log email sends for debugging and monitoring:

```typescript
async function sendWithLogging(options: SendEmailOptions) {
  const startTime = Date.now();
  const { data, error } = await drop(options);
  const duration = Date.now() - startTime;
  
  if (error) {
    console.error('[Email] Failed:', {
      to: options.to,
      error: error.message,
      duration,
    });
  } else {
    console.log('[Email] Sent:', {
      to: options.to,
      messageId: data?.messageId,
      duration,
    });
  }
  
  return { data, error };
}
```

### When to Use maildrop vs. Dedicated Services

**Use maildrop when:**
- ✅ Sending transactional emails (welcome emails, password resets, notifications)
- ✅ Low to medium volume (< 1000 emails/day)
- ✅ Personal projects or small applications
- ✅ You want to use your existing email account

**Consider dedicated services when:**
- ❌ High volume (> 1000 emails/day)
- ❌ Marketing campaigns or newsletters
- ❌ Need advanced analytics and tracking
- ❌ Need guaranteed delivery rates
- ❌ Enterprise requirements

Popular alternatives: SendGrid, Mailgun, AWS SES, Postmark, Resend

## License

ISC

## Contributing

Contributions welcome! Feel free to open issues or submit pull requests.

