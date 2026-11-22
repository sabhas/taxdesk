import { useEffect, useId, useState } from 'react';
import { LoaderCircle, MessageCircle, Share2 } from 'lucide-react';
import type { InvoiceShareChannel, InvoiceShareContext } from '@taxdesk/shared';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button, buttonVariants } from '@/components/ui/button';
import { fetchInvoicePdf, getInvoiceShareContext, recordInvoiceShare } from '../../billing-api.js';
import {
  ErrorAlert,
  InfoNotice,
  LoadingMessage,
  type ErrorNotice,
} from '../../components/feedback.js';
import { toErrorNotice } from '../error-notice.js';

interface Prepared {
  readonly context: InvoiceShareContext;
  readonly file: File;
  readonly canShareFile: boolean;
}

/** Older browsers have neither method, whatever the DOM typings say. */
type ShareNavigator = Partial<Pick<Navigator, 'canShare' | 'share'>>;

/** Whether this browser can hand a file to the device share sheet. */
function canShareFile(file: File): boolean {
  const browser: ShareNavigator = navigator;
  if (typeof browser.share !== 'function' || typeof browser.canShare !== 'function') {
    return false;
  }
  try {
    return browser.canShare({ files: [file] });
  } catch {
    return false;
  }
}

export function whatsAppUrl(context: InvoiceShareContext): string {
  const text = `?text=${encodeURIComponent(context.message)}`;
  return `https://wa.me/${context.whatsappPhone ?? ''}${text}`;
}

/** `923001234567` → `+92 300 1234567`, for showing who WhatsApp will open. */
function displayPhone(digits: string): string {
  return digits.startsWith('92') && digits.length === 12
    ? `+92 ${digits.slice(2, 5)} ${digits.slice(5)}`
    : `+${digits}`;
}

function saveFile(file: File): void {
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url;
  link.download = file.name;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 60_000);
}

/**
 * Share an invoice with its client (TD-513; ADR 0012). Opening the dialog
 * fetches the message and the PDF; the share itself then starts from a fresh
 * click, which browsers require for the share sheet. TaxDesk sends nothing:
 * the device or WhatsApp does, and a completed share is recorded.
 */
export function ShareInvoiceDialog({
  invoiceId,
  invoiceNumber,
  open,
  onOpenChange,
  onShared,
  onNotRecorded,
}: {
  readonly invoiceId: string;
  readonly invoiceNumber: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onShared: (message: string) => void;
  /** The device shared the invoice but TaxDesk could not record it. */
  readonly onNotRecorded: (notice: ErrorNotice) => void;
}) {
  const id = useId();
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [notice, setNotice] = useState<ErrorNotice | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!open) {
      return;
    }
    const request = { active: true };
    setPrepared(null);
    setNotice(null);
    setInfo(null);
    void (async () => {
      try {
        const context = await getInvoiceShareContext(invoiceId);
        let blob: Blob;
        try {
          blob = await fetchInvoicePdf(invoiceId);
        } catch (error) {
          if (request.active) {
            setNotice(toErrorNotice(error, 'Could not download the invoice PDF'));
          }
          return;
        }
        const file = new File([blob], context.fileName, { type: 'application/pdf' });
        if (request.active) {
          setPrepared({ context, file, canShareFile: canShareFile(file) });
        }
      } catch (error) {
        if (request.active) {
          setNotice(toErrorNotice(error, 'Could not prepare the invoice for sharing'));
        }
      }
    })();
    return () => {
      request.active = false;
    };
  }, [open, invoiceId, attempt]);

  async function record(channel: InvoiceShareChannel, done: string): Promise<void> {
    try {
      await recordInvoiceShare(invoiceId, channel);
      onShared(done);
    } catch (error) {
      const failure = toErrorNotice(error, 'Shared, but not recorded');
      onNotRecorded({
        ...failure,
        title: 'Shared, but not recorded',
        message: `${done} TaxDesk could not record the share, so it is missing from the invoice history. ${failure.message}`,
      });
    }
    onOpenChange(false);
  }

  async function shareSheet(): Promise<void> {
    if (prepared === null) {
      return;
    }
    setSharing(true);
    setNotice(null);
    setInfo(null);
    try {
      const browser: ShareNavigator = navigator;
      await browser.share?.({
        files: [prepared.file],
        title: prepared.context.title,
        text: prepared.context.message,
      });
    } catch (error) {
      setSharing(false);
      if (error instanceof DOMException && error.name === 'AbortError') {
        setInfo('Sharing was cancelled. Nothing was sent.');
      } else {
        setNotice({
          title: 'Could not open the share sheet',
          message: 'Your device refused to share the file. Use Send on WhatsApp instead.',
        });
      }
      return;
    }
    await record('share_sheet', `Invoice ${invoiceNumber} shared.`);
    setSharing(false);
  }

  function whatsApp(): void {
    if (prepared === null) {
      return;
    }
    // The link itself opens WhatsApp; this saves the PDF for staff to attach.
    saveFile(prepared.file);
    setSharing(true);
    void record(
      'whatsapp',
      `WhatsApp opened for invoice ${invoiceNumber}. Attach the downloaded file ${prepared.file.name} to the chat before sending.`,
    ).finally(() => {
      setSharing(false);
    });
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!sharing) {
          onOpenChange(next);
        }
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Share invoice {invoiceNumber}</AlertDialogTitle>
          <AlertDialogDescription>
            Send the invoice PDF and this message to the client from your device. TaxDesk records
            that you shared it.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {notice !== null && <ErrorAlert notice={notice} />}
        {info !== null && <InfoNotice>{info}</InfoNotice>}
        {prepared === null && notice === null && (
          <LoadingMessage>Preparing the invoice for sharing…</LoadingMessage>
        )}
        {prepared !== null && (
          <div className="space-y-3 text-sm">
            <div>
              <p id={`${id}-message-label`} className="font-medium">
                Message
              </p>
              <p
                aria-labelledby={`${id}-message-label`}
                className="mt-1 rounded-md border bg-muted/40 p-3 whitespace-pre-line"
              >
                {prepared.context.message}
              </p>
            </div>
            <p className="text-muted-foreground">
              Attachment: {prepared.file.name}.{' '}
              {prepared.context.whatsappPhone === null
                ? 'The client has no phone on file, so choose the chat in WhatsApp.'
                : `WhatsApp opens a chat with ${displayPhone(prepared.context.whatsappPhone)}.`}
            </p>
            {!prepared.canShareFile && (
              <p className="text-muted-foreground">
                This browser cannot attach files to a share. Send on WhatsApp downloads the PDF;
                attach it to the chat before sending.
              </p>
            )}
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={sharing}>Close</AlertDialogCancel>
          {notice !== null && prepared === null && (
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setAttempt((value) => value + 1);
              }}
            >
              Try again
            </Button>
          )}
          {prepared !== null && (
            <a
              href={whatsAppUrl(prepared.context)}
              target="_blank"
              rel="noopener noreferrer"
              aria-disabled={sharing}
              className={buttonVariants({
                variant: prepared.canShareFile ? 'outline' : 'default',
              })}
              onClick={(event) => {
                if (sharing) {
                  event.preventDefault();
                  return;
                }
                whatsApp();
              }}
            >
              <MessageCircle aria-hidden="true" />
              Send on WhatsApp
            </a>
          )}
          {prepared?.canShareFile === true && (
            <Button
              type="button"
              disabled={sharing}
              aria-busy={sharing}
              onClick={() => void shareSheet()}
            >
              {sharing ? (
                <LoaderCircle aria-hidden="true" className="animate-spin" />
              ) : (
                <Share2 aria-hidden="true" />
              )}
              Share PDF…
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
