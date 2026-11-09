import type { ErrorNotice } from '../components/feedback.js';
import { ApiError } from '../api-client.js';

/** Maps a public API failure to an accessible notice. Never shows raw errors. */
export function toErrorNotice(error: unknown, fallbackTitle = 'Something went wrong'): ErrorNotice {
  if (error instanceof ApiError) {
    if (error.code === 'NETWORK_ERROR') {
      return {
        title: 'Connection problem',
        message: 'We could not reach TaxDesk. Check your connection and try again.',
        ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
      };
    }
    if (error.code === 'INVALID_CREDENTIALS') {
      return {
        title: 'Sign-in failed',
        message: error.message,
        ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
      };
    }
    if (error.status === 403 && error.code === 'FORBIDDEN') {
      // The API is authoritative: navigation may still show an affordance the
      // server now refuses, so explain the denial without revealing the record.
      return {
        title: 'Access denied',
        message: 'Your role does not allow this action. Ask an administrator if you need access.',
        ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
      };
    }
    if (error.code === 'TOO_MANY_ATTEMPTS') {
      return {
        title: 'Too many attempts',
        message: error.message,
        ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
      };
    }
    if (error.code === 'VALIDATION_FAILED') {
      return {
        title: 'Check the form',
        message: error.message,
        ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
        ...(error.fieldErrors.length === 0 ? {} : { fields: error.fieldErrors }),
      };
    }
    return {
      title: fallbackTitle,
      message: error.message,
      ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
    };
  }
  return {
    title: fallbackTitle,
    message: 'The request could not be completed. Please try again.',
  };
}
