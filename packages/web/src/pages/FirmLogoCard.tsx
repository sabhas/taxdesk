import { useId, useRef, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { FIRM_LOGO_LIMITS, type FirmSettings } from '@taxdesk/shared';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { ApiError } from '../api-client.js';
import { firmLogoUrl, removeFirmLogo, uploadFirmLogo } from '../auth-client.js';
import { ErrorAlert, SuccessNotice, type ErrorNotice } from '../components/feedback.js';
import { toErrorNotice } from './error-notice.js';

const MAX_KIB = FIRM_LOGO_LIMITS.maxBytes / 1024;
const ACCEPT = FIRM_LOGO_LIMITS.contentTypes.join(',');

/** A quick check before upload; the server repeats it on the file's bytes. */
function fileProblem(file: File): string | null {
  if (!(FIRM_LOGO_LIMITS.contentTypes as readonly string[]).includes(file.type)) {
    return 'Use a PNG or JPEG image.';
  }
  if (file.size > FIRM_LOGO_LIMITS.maxBytes) {
    return `Use a logo of at most ${String(MAX_KIB)} KiB.`;
  }
  if (file.size === 0) {
    return 'Choose a logo image to upload.';
  }
  return null;
}

/**
 * Firm logo on invoices and receipts (TD-512). Administrators upload, replace,
 * or remove it; everyone else sees the current logo.
 */
export function FirmLogoCard({
  settings,
  canManage,
  onChange,
}: {
  readonly settings: FirmSettings;
  readonly canManage: boolean;
  readonly onChange: (settings: FirmSettings) => void;
}) {
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [notice, setNotice] = useState<ErrorNotice | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busy, setBusy] = useState<'upload' | 'remove' | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const logo = settings.logo;

  function choose(next: File | null): void {
    setNotice(null);
    setSuccess(null);
    setFile(next);
    setFileError(next === null ? null : fileProblem(next));
  }

  function failed(error: unknown, title: string): void {
    if (error instanceof ApiError && error.status === 412) {
      setNotice({
        title: 'Settings changed',
        message: 'Someone else changed the firm settings. Reload the page and try again.',
        ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
      });
      return;
    }
    const logoError =
      error instanceof ApiError
        ? error.fieldErrors.find((field) => field.field === 'logo')
        : undefined;
    if (logoError !== undefined) {
      setFileError(logoError.message);
      return;
    }
    setNotice(toErrorNotice(error, title));
  }

  async function upload(): Promise<void> {
    if (file === null) {
      setFileError('Choose a logo image to upload.');
      return;
    }
    const problem = fileProblem(file);
    if (problem !== null) {
      setFileError(problem);
      return;
    }
    setBusy('upload');
    setNotice(null);
    setSuccess(null);
    try {
      const updated = await uploadFirmLogo(file, settings.version);
      onChange(updated);
      setFile(null);
      if (inputRef.current !== null) {
        inputRef.current.value = '';
      }
      setSuccess('Logo saved. New invoice and receipt PDFs will show it.');
    } catch (error) {
      failed(error, 'Could not save the logo');
    } finally {
      setBusy(null);
    }
  }

  async function remove(): Promise<void> {
    setBusy('remove');
    setNotice(null);
    setSuccess(null);
    try {
      const updated = await removeFirmLogo(settings.version);
      onChange(updated);
      setConfirmOpen(false);
      setSuccess('Logo removed. New invoice and receipt PDFs will have no logo.');
    } catch (error) {
      setConfirmOpen(false);
      failed(error, 'Could not remove the logo');
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className="mt-6 max-w-2xl" aria-labelledby={`${id}-title`}>
      <CardHeader>
        <CardTitle>
          <h2 id={`${id}-title`}>Firm logo</h2>
        </CardTitle>
        <CardDescription>
          Printed at the top of invoice and receipt PDFs created from now on. PDFs that already
          exist keep the logo they were made with.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {notice !== null && <ErrorAlert notice={notice} />}
        {success !== null && <SuccessNotice>{success}</SuccessNotice>}
        {logo === null ? (
          <p className="text-sm text-muted-foreground">
            No logo uploaded. PDFs show the firm name only.
          </p>
        ) : (
          <div className="flex items-center gap-4">
            <div className="flex h-20 w-48 items-center justify-center rounded-md border bg-white p-2">
              <img
                src={firmLogoUrl(logo.sha256)}
                alt="Current firm logo"
                className="max-h-full max-w-full object-contain"
              />
            </div>
            <p className="text-sm text-muted-foreground">
              {logo.contentType === 'image/png' ? 'PNG' : 'JPEG'},{' '}
              {String(Math.max(1, Math.round(logo.byteSize / 1024)))} KiB
            </p>
          </div>
        )}
        {canManage ? (
          <>
            <Field data-invalid={fileError !== null}>
              <FieldLabel htmlFor={`${id}-file`}>
                {logo === null ? 'Logo image' : 'Replace with'}
              </FieldLabel>
              <Input
                ref={inputRef}
                id={`${id}-file`}
                type="file"
                accept={ACCEPT}
                disabled={busy !== null}
                aria-invalid={fileError !== null}
                aria-describedby={`${id}-help${fileError === null ? '' : ` ${id}-error`}`}
                onChange={(event) => {
                  choose(event.target.files?.[0] ?? null);
                }}
              />
              <FieldDescription id={`${id}-help`}>
                PNG or JPEG, up to {MAX_KIB} KiB and {FIRM_LOGO_LIMITS.maxSidePixels} pixels on each
                side. A wide logo on a white or transparent background prints best.
              </FieldDescription>
              {fileError !== null && <FieldError id={`${id}-error`}>{fileError}</FieldError>}
            </Field>
            <div className="flex flex-wrap justify-end gap-2">
              {logo !== null && (
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy !== null}
                  onClick={() => {
                    setConfirmOpen(true);
                  }}
                >
                  Remove logo
                </Button>
              )}
              <Button
                type="button"
                disabled={busy !== null || file === null || fileError !== null}
                aria-busy={busy === 'upload'}
                onClick={() => void upload()}
              >
                {busy === 'upload' && <LoaderCircle aria-hidden="true" className="animate-spin" />}
                {busy === 'upload' ? 'Uploading…' : logo === null ? 'Upload logo' : 'Replace logo'}
              </Button>
            </div>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            Your role can view but not change the firm logo.
          </p>
        )}
      </CardContent>
      <AlertDialog
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!open && busy === null) {
            setConfirmOpen(false);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove the firm logo?</AlertDialogTitle>
            <AlertDialogDescription>
              New invoice and receipt PDFs will show the firm name without a logo. PDFs that already
              exist are not changed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy !== null}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              type="button"
              variant="destructive"
              disabled={busy !== null}
              aria-busy={busy === 'remove'}
              onClick={() => void remove()}
            >
              {busy === 'remove' && <LoaderCircle aria-hidden="true" className="animate-spin" />}
              Remove logo
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
