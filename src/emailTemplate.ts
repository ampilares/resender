/** Escape a string for safe interpolation into HTML. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Turn an arbitrary field value into a display string. */
export function stringify(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Humanize a field key: "first_name" -> "First name". */
export function label(key: string): string {
  const spaced = key.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export interface RenderedEmail {
  html: string;
  text: string;
}

/**
 * Render submitted form fields as a clean HTML table plus a plain-text
 * alternative. All keys and values are HTML-escaped.
 */
export function renderSubmission(
  formName: string,
  fields: Record<string, unknown>,
): RenderedEmail {
  const entries = Object.entries(fields);

  const rows = entries
    .map(([key, raw]) => {
      const val = escapeHtml(stringify(raw)).replace(/\n/g, '<br>');
      return `        <tr>
          <td style="padding:8px 12px;border:1px solid #e5e7eb;background:#f9fafb;font-weight:600;vertical-align:top;white-space:nowrap;">${escapeHtml(label(key))}</td>
          <td style="padding:8px 12px;border:1px solid #e5e7eb;vertical-align:top;">${val || '<span style="color:#9ca3af;">(empty)</span>'}</td>
        </tr>`;
    })
    .join('\n');

  const html = `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827;">
    <div style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:8px;overflow:hidden;border:1px solid #e5e7eb;">
      <div style="padding:16px 20px;background:#111827;color:#ffffff;">
        <div style="font-size:16px;font-weight:600;">New submission</div>
        <div style="font-size:13px;color:#9ca3af;">${escapeHtml(formName)}</div>
      </div>
      <div style="padding:20px;">
        <table style="width:100%;border-collapse:collapse;font-size:14px;">
${rows || '        <tr><td style="padding:8px 12px;color:#9ca3af;">No fields submitted.</td></tr>'}
        </table>
      </div>
      <div style="padding:12px 20px;background:#f9fafb;border-top:1px solid #e5e7eb;font-size:12px;color:#9ca3af;">
        Delivered by resender
      </div>
    </div>
  </body>
</html>`;

  const textLines = entries.map(([key, raw]) => `${label(key)}: ${stringify(raw)}`);
  const text = `New submission — ${formName}\n\n${textLines.join('\n') || 'No fields submitted.'}\n\n—\nDelivered by resender`;

  return { html, text };
}
