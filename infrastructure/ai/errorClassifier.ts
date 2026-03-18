import type { ChatMessage } from './types';

/**
 * Convert a raw error string into display-safe error info.
 *
 * Intentionally avoids keyword-based "root cause" attribution because upstream
 * providers often return generic 4xx/5xx text that would be misclassified.
 * We show the sanitized upstream message directly instead.
 */
export function classifyError(error: string): NonNullable<ChatMessage['errorInfo']> {
  const message = sanitizeErrorMessage(error).trim() || 'Unknown error';
  return { type: 'unknown', message, retryable: false };
}

const MAX_ERROR_MESSAGE_LENGTH = 500;

/**
 * Sanitize an error message before displaying it to the user.
 * Strips file paths, URLs with credentials, and truncates long messages.
 */
export function sanitizeErrorMessage(msg: string): string {
  let sanitized = msg;

  // Strip file system paths (Unix and Windows)
  sanitized = sanitized.replace(/(?:\/Users\/|\/home\/|\/tmp\/|\/var\/|[A-Z]:\\)[^\s"'`,;)}\]>]*/gi, '<path>');

  // Strip URLs containing API keys or tokens in query params
  sanitized = sanitized.replace(/https?:\/\/[^\s"']*[?&](key|token|api_key|apikey|secret|access_token|auth)=[^\s"'&]*/gi, '<url-redacted>');

  // Truncate overly long messages
  if (sanitized.length > MAX_ERROR_MESSAGE_LENGTH) {
    sanitized = sanitized.slice(0, MAX_ERROR_MESSAGE_LENGTH) + '...';
  }

  return sanitized;
}
