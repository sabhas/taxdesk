import type {
  DocumentProviderState,
  DocumentVerificationState,
  ReconciliationNextAction,
  StorageCallbackResult,
  StorageConnectionStatus,
  StorageHealthReason,
} from '@taxdesk/shared';

type BadgeVariant = 'default' | 'secondary' | 'success' | 'warning' | 'destructive' | 'outline';

export const VERIFICATION_LABELS: Readonly<Record<DocumentVerificationState, string>> = {
  pending: 'Awaiting review',
  verified: 'Verified',
  rejected: 'Rejected',
  missing_provider: 'Missing in storage',
};

export const VERIFICATION_BADGE: Readonly<Record<DocumentVerificationState, BadgeVariant>> = {
  pending: 'outline',
  verified: 'success',
  rejected: 'destructive',
  missing_provider: 'warning',
};

/** Only unusual provider states get a badge; `present` is the norm. */
export const PROVIDER_STATE_LABELS: Readonly<Record<DocumentProviderState, string | null>> = {
  present: null,
  missing: 'Missing in storage',
  moved: 'Moved',
};

export const CONNECTION_STATUS_LABELS: Readonly<Record<StorageConnectionStatus, string>> = {
  not_connected: 'Not connected',
  healthy: 'Connected',
  reconnect_required: 'Reconnect required',
  unavailable: 'Temporarily unavailable',
};

export const CONNECTION_STATUS_BADGE: Readonly<Record<StorageConnectionStatus, BadgeVariant>> = {
  not_connected: 'secondary',
  healthy: 'success',
  reconnect_required: 'destructive',
  unavailable: 'warning',
};

export const HEALTH_REASON_TEXT: Readonly<Record<StorageHealthReason, string>> = {
  consent_revoked:
    'Access to the storage account was withdrawn. An administrator must reconnect it.',
  refresh_failed:
    'TaxDesk could not renew its access to the storage account. An administrator must reconnect it.',
  provider_unavailable:
    'The storage service did not respond. TaxDesk will keep trying; check again later.',
  rate_limited: 'The storage service asked TaxDesk to slow down. Try again in a few minutes.',
  folder_unavailable:
    'The TaxDesk folder in the storage account could not be reached. Reconnect the account.',
  not_configured: 'This deployment is not configured for document storage yet.',
};

export const NEXT_ACTION_TEXT: Readonly<Record<ReconciliationNextAction, string>> = {
  none: 'Nothing to do — every stored document was found.',
  review_missing_documents:
    'Review documents marked "Missing in storage" and upload replacements where needed.',
  reconnect_storage: 'Reconnect the storage account, then run reconciliation again.',
  retry_later: 'The storage service was unavailable. Run reconciliation again later.',
};

export const CALLBACK_RESULT_TEXT: Readonly<
  Record<StorageCallbackResult, { tone: 'success' | 'error'; title: string; message: string }>
> = {
  connected: {
    tone: 'success',
    title: 'Storage connected',
    message: 'TaxDesk can now store documents in the connected account.',
  },
  denied: {
    tone: 'error',
    title: 'Connection not approved',
    message: 'Consent was not granted, so nothing changed. Try again when ready.',
  },
  expired: {
    tone: 'error',
    title: 'Connection attempt expired',
    message: 'The sign-in took too long. Start the connection again.',
  },
  invalid_state: {
    tone: 'error',
    title: 'Connection attempt not recognised',
    message:
      'This response did not match a connection you started. Start the connection again from this page.',
  },
  failed: {
    tone: 'error',
    title: 'Connection failed',
    message:
      'The storage account could not be connected. Try again, or check the deployment configuration.',
  },
};
