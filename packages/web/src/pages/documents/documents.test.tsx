import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { axe } from 'vitest-axe';
import {
  permissionsForRoles,
  type CaseChecklistItem,
  type CurrentSession,
  type Document,
  type DocumentList,
  type RoleKey,
  type UploadSession,
} from '@taxdesk/shared';
import { ApiError } from '../../api-client.js';
import type { UploadTransport } from '../../document-api.js';
import { SessionProvider } from '../../session/session-context.js';
import { DocumentsPanel, verifiedCountsByItem, type DocumentsScope } from './DocumentsPanel.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const USER_ID = '0198a000-0000-7000-8000-000000000001';
const CLIENT_ID = '0198a000-0000-7000-8000-0000000000c1';
const CASE_ID = '0198a000-0000-7000-8000-0000000000a1';
const ITEM_ID = '0198a000-0000-7000-8000-0000000000a2';
const DOC_ID = '0198a000-0000-7000-8000-0000000000d1';
const DOC2_ID = '0198a000-0000-7000-8000-0000000000d2';
const UPLOAD_ID = '0198a000-0000-7000-8000-0000000000b1';
const NOW = '2026-06-01T04:00:00.000Z';

function sessionFor(role: RoleKey): CurrentSession {
  return {
    user: {
      id: USER_ID,
      username: 'person',
      displayName: 'Test Person',
      status: 'active',
      mfaEnrolled: true,
      createdAt: NOW,
    },
    roles: [role],
    permissions: permissionsForRoles([role]),
    session: {
      idleExpiresAt: '2026-06-01T04:30:00.000Z',
      absoluteExpiresAt: '2026-06-01T16:00:00.000Z',
      mfaVerified: true,
    },
  };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'X-Request-Id': 'req-test' },
  });
}

function problem(status: number, code: string, detail: string): Response {
  return new Response(
    JSON.stringify({
      type: `https://taxdesk.app/problems/${code.toLowerCase()}`,
      title: 'Error',
      status,
      code,
      detail,
      requestId: 'req-problem',
    }),
    { status, headers: { 'Content-Type': 'application/problem+json' } },
  );
}

const ALL_ALLOWED = { open: true, edit: true, review: true, delete: true, restore: true };

function doc(overrides: Partial<Document> = {}): Document {
  return {
    id: DOC_ID,
    clientId: CLIENT_ID,
    clientCode: 'CL-00001',
    clientName: 'Synthetic Client',
    caseId: CASE_ID,
    caseCode: 'TC-00001',
    checklistItemId: ITEM_ID,
    checklistItemLabel: 'Bank statement',
    documentType: 'Bank statement',
    fileName: 'statement-june.pdf',
    contentType: 'application/pdf',
    sizeBytes: 2_400_000,
    verificationState: 'pending',
    verificationNote: null,
    verifiedByName: null,
    verifiedAt: null,
    providerState: 'present',
    lastReconciledAt: null,
    uploadedByName: 'Test Person',
    uploadedAt: NOW,
    deletedAt: null,
    deletedByName: null,
    version: 1,
    permissions: ALL_ALLOWED,
    ...overrides,
  };
}

function page(documents: Document[], overrides: Partial<DocumentList> = {}): DocumentList {
  return {
    documents,
    nextCursor: null,
    storageAvailable: true,
    maxUploadBytes: 250 * 1024 * 1024,
    permissions: { upload: true },
    ...overrides,
  };
}

const checklist: CaseChecklistItem[] = [
  {
    id: ITEM_ID,
    key: 'bank',
    label: 'Bank statement',
    documentType: 'Bank statement',
    required: true,
    reviewRequired: true,
    instructions: '',
    state: 'open',
    completedBy: null,
    completedAt: null,
    preparerComment: '',
    reviewedBy: null,
    reviewedAt: null,
    reviewComment: '',
    version: 1,
  } as unknown as CaseChecklistItem,
];

const caseScope: DocumentsScope = {
  kind: 'case',
  caseId: CASE_ID,
  clientId: CLIENT_ID,
  checklist,
};

interface Recorded {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown>;
}

type Handler = (request: Recorded) => Response | undefined;

function mockApi(role: RoleKey, handlers: Handler[]): Recorded[] {
  const recorded: Recorded[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((input: string, init: RequestInit = {}) => {
      const request: Recorded = {
        method: init.method ?? 'GET',
        url: input,
        headers: (init.headers ?? {}) as Record<string, string>,
        body:
          typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {},
      };
      recorded.push(request);
      for (const handler of handlers) {
        const response = handler(request);
        if (response !== undefined) return Promise.resolve(response);
      }
      if (input === '/api/v1/auth/session') return Promise.resolve(json(sessionFor(role)));
      return Promise.resolve(problem(500, 'INTERNAL_ERROR', `Unmocked ${request.method} ${input}`));
    }),
  );
  return recorded;
}

function renderPanel(
  scope: DocumentsScope = caseScope,
  props: { transport?: UploadTransport; onChanged?: () => void } = {},
) {
  return render(
    <MemoryRouter>
      <SessionProvider>
        <DocumentsPanel scope={scope} {...props} />
      </SessionProvider>
    </MemoryRouter>,
  );
}

async function expectNoSeriousViolations(container: HTMLElement): Promise<void> {
  const results = await axe(container);
  expect(
    results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical'),
  ).toEqual([]);
}

describe('documents panel (TD-406–TD-409)', () => {
  it('lists case documents with review actions and an accessible layout', async () => {
    const recorded = mockApi('manager', [
      (r) => (r.url.startsWith('/api/v1/documents?') ? json(page([doc()])) : undefined),
    ]);
    const rendered = renderPanel();
    expect(
      await screen.findByText('statement-june.pdf', { selector: '.break-all' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Awaiting review')).toBeInTheDocument();
    expect(screen.getByText(/2\.3 MB/u)).toBeInTheDocument();
    const open = screen.getByRole('link', { name: /Open statement-june\.pdf/u });
    expect(open).toHaveAttribute('href', `/api/v1/documents/${DOC_ID}/content`);
    expect(screen.getByRole('button', { name: /Verify statement-june\.pdf/u })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Reject statement-june\.pdf/u })).toBeEnabled();
    expect(recorded.find((r) => r.url.startsWith('/api/v1/documents?'))?.url).toBe(
      `/api/v1/documents?caseId=${CASE_ID}&state=active&limit=50`,
    );
    await expectNoSeriousViolations(rendered.container);
  });

  it('hides actions the API does not allow', async () => {
    mockApi('read_only', [
      (r) =>
        r.url.startsWith('/api/v1/documents?')
          ? json(
              page(
                [
                  doc({
                    permissions: {
                      open: true,
                      edit: false,
                      review: false,
                      delete: false,
                      restore: false,
                    },
                  }),
                ],
                { permissions: { upload: false } },
              ),
            )
          : undefined,
    ]);
    renderPanel();
    expect(
      await screen.findByText('statement-june.pdf', { selector: '.break-all' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open/u })).toBeInTheDocument();
    for (const name of [/Verify/u, /Reject/u, /Edit/u, /Delete/u, /Upload document/u]) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
  });

  it('pauses uploads and opens while storage is unavailable (non-administrator)', async () => {
    mockApi('consultant', [
      (r) =>
        r.url.startsWith('/api/v1/documents?')
          ? json(page([doc()], { storageAvailable: false }))
          : undefined,
    ]);
    renderPanel();
    expect(
      await screen.findByText(/Document storage is unavailable — contact an administrator/u),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Upload document' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Open statement-june\.pdf/u })).toBeDisabled();
    expect(screen.queryByRole('link', { name: /Reconnect storage/u })).not.toBeInTheDocument();
  });

  it('gives administrators a reconnect call to action', async () => {
    mockApi('administrator', [
      (r) =>
        r.url.startsWith('/api/v1/documents?')
          ? json(page([], { storageAvailable: false }))
          : undefined,
      (r) =>
        r.url === '/api/v1/storage/connection'
          ? json({
              id: '0198a000-0000-7000-8000-0000000000e9',
              providerType: 'onedrive',
              status: 'reconnect_required',
              healthReason: 'consent_revoked',
              accountLabel: null,
              connectedAt: NOW,
              connectedByName: null,
              lastCheckedAt: NOW,
              lastRefreshedAt: NOW,
              version: 2,
              configured: true,
              permissions: { manage: true },
            })
          : undefined,
    ]);
    renderPanel();
    expect(
      await screen.findByText(/Access to the storage account was withdrawn/u),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Reconnect storage' })).toHaveAttribute(
      'href',
      '/settings/storage',
    );
  });

  it('marks documents missing in storage and moved files', async () => {
    mockApi('manager', [
      (r) =>
        r.url.startsWith('/api/v1/documents?')
          ? json(
              page([
                doc({ verificationState: 'missing_provider', providerState: 'missing' }),
                doc({ id: DOC2_ID, fileName: 'moved.pdf', providerState: 'moved' }),
              ]),
            )
          : undefined,
    ]);
    renderPanel();
    expect(await screen.findByText('Missing in storage')).toBeInTheDocument();
    expect(screen.getByText('Moved')).toBeInTheDocument();
    // A missing document cannot be opened.
    expect(screen.getByRole('button', { name: /Open statement-june\.pdf/u })).toBeDisabled();
    expect(screen.getByRole('link', { name: /Open moved\.pdf/u })).toBeInTheDocument();
  });

  it('requires a reason to reject and sends If-Match', async () => {
    const onChanged = vi.fn();
    const recorded = mockApi('manager', [
      (r) => (r.url.startsWith('/api/v1/documents?') ? json(page([doc()])) : undefined),
      (r) =>
        r.url === `/api/v1/documents/${DOC_ID}/review`
          ? json(
              doc({
                verificationState: 'rejected',
                verificationNote: 'Pages missing',
                verifiedAt: NOW,
                verifiedByName: 'Test Person',
                version: 2,
              }),
            )
          : undefined,
    ]);
    renderPanel(caseScope, { onChanged });
    fireEvent.click(await screen.findByRole('button', { name: /Reject statement-june\.pdf/u }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reject' }));
    expect(
      await within(dialog).findByText('Explain why the document is rejected.'),
    ).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Reason (required)'), {
      target: { value: 'Pages missing' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reject' }));
    expect(await screen.findByText('statement-june.pdf was rejected.')).toBeInTheDocument();
    const review = recorded.find((r) => r.url.endsWith('/review'));
    expect(review?.headers['If-Match']).toBe('"1"');
    expect(review?.body).toEqual({ decision: 'rejected', note: 'Pages missing' });
    expect(screen.getByText('Review note: Pages missing')).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalled();
  });

  it('refreshes the list after a version conflict', async () => {
    let lists = 0;
    mockApi('manager', [
      (r) => {
        if (!r.url.startsWith('/api/v1/documents?')) return undefined;
        lists += 1;
        return json(page([doc({ version: lists })]));
      },
      (r) =>
        r.url === `/api/v1/documents/${DOC_ID}` && r.method === 'DELETE'
          ? problem(412, 'PRECONDITION_FAILED', 'Stale.')
          : undefined,
    ]);
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: /Delete statement-june\.pdf/u }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete document' }));
    expect(
      await screen.findByRole('heading', { name: 'This document changed' }),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(lists).toBe(2);
    });
  });

  it('shows deleted documents on request and restores them', async () => {
    const recorded = mockApi('manager', [
      (r) =>
        r.url.startsWith('/api/v1/documents?')
          ? json(
              page(
                r.url.includes('state=all')
                  ? [doc({ deletedAt: NOW, deletedByName: 'Test Person', version: 4 })]
                  : [],
              ),
            )
          : undefined,
      (r) =>
        r.url === `/api/v1/documents/${DOC_ID}/restore` ? json(doc({ version: 5 })) : undefined,
    ]);
    renderPanel();
    expect(await screen.findByText('No documents yet')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show deleted documents' }));
    expect(await screen.findByText('Deleted')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Restore statement-june\.pdf/u }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restore document' }));
    expect(await screen.findByText('statement-june.pdf was restored.')).toBeInTheDocument();
    expect(recorded.find((r) => r.url.endsWith('/restore'))?.headers['If-Match']).toBe('"4"');
  });

  it('validates the file before uploading', async () => {
    mockApi('manager', [
      (r) =>
        r.url.startsWith('/api/v1/documents?') ? json(page([], { maxUploadBytes: 10 })) : undefined,
    ]);
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Upload document' }));
    const input = await screen.findByLabelText('File');
    fireEvent.change(input, {
      target: { files: [new File(['x'], 'payload.exe', { type: 'application/octet-stream' })] },
    });
    expect(
      await screen.findByText(/Upload a PDF, JPEG, PNG, DOCX, XLSX, or CSV file/u),
    ).toBeInTheDocument();
    fireEvent.change(input, {
      target: { files: [new File(['x'.repeat(20)], 'big.pdf', { type: 'application/pdf' })] },
    });
    expect(await screen.findByText(/larger than the 10 B limit/u)).toBeInTheDocument();
  });

  it('uploads a file in chunks, prefilling the type from the checklist item', async () => {
    let listed = 0;
    const onChanged = vi.fn();
    mockApi('manager', [
      (r) => {
        if (!r.url.startsWith('/api/v1/documents?')) return undefined;
        listed += 1;
        return json(page(listed === 1 ? [] : [doc()]));
      },
    ]);
    const session: UploadSession = {
      id: UPLOAD_ID,
      documentId: DOC_ID,
      state: 'active',
      fileName: 'statement-june.pdf',
      sizeBytes: 6,
      nextOffset: 0,
      chunkBytes: 5 * 1024 * 1024,
      expiresAt: '2026-06-02T00:00:00.000Z',
    };
    const created: unknown[] = [];
    const transport: UploadTransport = {
      createUpload: (request) => {
        created.push(request);
        return Promise.resolve(session);
      },
      getUpload: () => Promise.resolve(session),
      putChunk: (_id, offset, chunk) =>
        Promise.resolve({ nextOffset: offset + chunk.size, complete: true }),
      complete: () => Promise.resolve(doc()),
      cancel: () => Promise.resolve(),
    };
    renderPanel(caseScope, { transport, onChanged });
    expect(await screen.findByText('No documents yet')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Upload document' }));
    fireEvent.change(await screen.findByLabelText('Checklist item'), {
      target: { value: ITEM_ID },
    });
    expect(screen.getByLabelText('Document type')).toHaveValue('Bank statement');
    fireEvent.change(screen.getByLabelText('File'), {
      target: { files: [new File(['%PDF-1'], 'statement-june.pdf', { type: 'application/pdf' })] },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Upload' }));
    expect(
      await screen.findByText('statement-june.pdf was uploaded and is awaiting review.'),
    ).toBeInTheDocument();
    expect(created).toEqual([
      {
        clientId: CLIENT_ID,
        caseId: CASE_ID,
        checklistItemId: ITEM_ID,
        documentType: 'Bank statement',
        fileName: 'statement-june.pdf',
        contentType: 'application/pdf',
        sizeBytes: 6,
      },
    ]);
    expect(
      await screen.findByText('statement-june.pdf', { selector: '.break-all' }),
    ).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalled();
  });

  it('shows the case code on client-level lists', async () => {
    const recorded = mockApi('manager', [
      (r) => (r.url.startsWith('/api/v1/documents?') ? json(page([doc()])) : undefined),
    ]);
    renderPanel({ kind: 'client', clientId: CLIENT_ID });
    expect(await screen.findByRole('link', { name: 'TC-00001' })).toBeInTheDocument();
    expect(recorded.find((r) => r.url.startsWith('/api/v1/documents?'))?.url).toContain(
      `clientId=${CLIENT_ID}`,
    );
  });
});

describe('checklist links require the item document type', () => {
  const session: UploadSession = {
    id: UPLOAD_ID,
    documentId: DOC_ID,
    state: 'active',
    fileName: 'statement-june.pdf',
    sizeBytes: 6,
    nextOffset: 0,
    chunkBytes: 5 * 1024 * 1024,
    expiresAt: '2026-06-02T00:00:00.000Z',
  };

  function transportWith(createUpload: UploadTransport['createUpload']): UploadTransport {
    return {
      createUpload,
      getUpload: () => Promise.resolve(session),
      putChunk: (_id, offset, chunk) =>
        Promise.resolve({ nextOffset: offset + chunk.size, complete: true }),
      complete: () => Promise.resolve(doc()),
      cancel: () => Promise.resolve(),
    };
  }

  it('always takes the type from a typed item and locks it while linked', async () => {
    mockApi('manager', [
      (r) => (r.url.startsWith('/api/v1/documents?') ? json(page([])) : undefined),
    ]);
    renderPanel(caseScope, { transport: transportWith(() => Promise.resolve(session)) });
    fireEvent.click(await screen.findByRole('button', { name: 'Upload document' }));
    const type = await screen.findByLabelText('Document type');
    fireEvent.change(type, { target: { value: 'Something else' } });
    fireEvent.change(screen.getByLabelText('Checklist item'), { target: { value: ITEM_ID } });
    expect(type).toHaveValue('Bank statement');
    expect(type).toHaveAttribute('readonly');
    expect(type).toHaveAccessibleDescription(/Set by the linked checklist item/u);
    fireEvent.change(screen.getByLabelText('Checklist item'), { target: { value: '' } });
    expect(type).not.toHaveAttribute('readonly');
  });

  it('shows DOCUMENT_LINK_INVALID on the type field and lets the user retry', async () => {
    mockApi('manager', [
      (r) => (r.url.startsWith('/api/v1/documents?') ? json(page([])) : undefined),
    ]);
    renderPanel(caseScope, {
      transport: transportWith(() =>
        Promise.reject(
          new ApiError({
            status: 400,
            code: 'DOCUMENT_LINK_INVALID',
            message: 'The document type must match the checklist item.',
          }),
        ),
      ),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Upload document' }));
    fireEvent.change(await screen.findByLabelText('File'), {
      target: { files: [new File(['%PDF-1'], 'statement-june.pdf', { type: 'application/pdf' })] },
    });
    fireEvent.change(screen.getByLabelText('Document type'), { target: { value: 'Other' } });
    fireEvent.click(screen.getByRole('button', { name: 'Upload' }));
    expect(
      await screen.findByText('The document type must match the checklist item.'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Document type')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('button', { name: 'Upload' })).toBeEnabled();
  });

  it('sets the type when the edit dialog links a typed item, and shows a link error', async () => {
    const recorded = mockApi('manager', [
      (r) =>
        r.url.startsWith('/api/v1/documents?')
          ? json(
              page([
                doc({ checklistItemId: null, checklistItemLabel: null, documentType: 'Other' }),
              ]),
            )
          : undefined,
      (r) =>
        r.method === 'PATCH'
          ? problem(
              400,
              'DOCUMENT_LINK_INVALID',
              'The document type must match the checklist item.',
            )
          : undefined,
    ]);
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: /Edit statement-june\.pdf/u }));
    fireEvent.change(await screen.findByLabelText('Checklist item'), {
      target: { value: ITEM_ID },
    });
    const type = screen.getByLabelText('Document type');
    expect(type).toHaveValue('Bank statement');
    expect(type).toHaveAttribute('readonly');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(
      await screen.findByText('The document type must match the checklist item.'),
    ).toBeInTheDocument();
    expect(recorded.find((r) => r.method === 'PATCH')?.body).toEqual({
      documentType: 'Bank statement',
      checklistItemId: ITEM_ID,
    });
  });
});

describe('verifiedCountsByItem', () => {
  it('counts only verified, non-deleted documents per checklist item', () => {
    const counts = verifiedCountsByItem([
      doc({ verificationState: 'verified' }),
      doc({ id: DOC2_ID, verificationState: 'verified', deletedAt: NOW }),
      doc({ verificationState: 'pending' }),
      doc({ checklistItemId: null, verificationState: 'verified' }),
    ]);
    expect(counts.get(ITEM_ID)).toBe(1);
    expect(counts.size).toBe(1);
  });
});
