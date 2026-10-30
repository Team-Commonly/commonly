/**
 * The browser-facing origin of THIS instance, for links the product sends out
 * (Telegram and Slack messages, decision-card replies, hosted-MCP redirects).
 *
 * Reads PUBLIC_APP_URL, then FRONTEND_URL (the chart sets this one), and takes
 * the first comma-separated entry. There is deliberately no commonly.me
 * fallback: a self-hosted or dev instance that reached this function with
 * neither variable set would otherwise hand its people production links. The
 * local dev origin is the only default, and it is never a reachable host from
 * a chat client, so a misconfigured instance fails visibly.
 */
export const DEV_FALLBACK = 'http://localhost:3000';

export const publicAppUrl = (): string => {
  const configured = String(process.env.PUBLIC_APP_URL || process.env.FRONTEND_URL || '')
    .split(',')[0]
    .trim();
  return (configured || DEV_FALLBACK).replace(/\/+$/, '');
};
