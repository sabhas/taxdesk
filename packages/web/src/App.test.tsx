import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { axe } from 'vitest-axe';
import { createJsonResponse, mockFetchJson } from '@taxdesk/test-utils';
import { App } from './App.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const health = {
  environment: 'staging',
  releaseVersion: '1.2.3',
  requestId: 'req-health',
};

describe('App', () => {
  it('shows a loading state before the API responds', () => {
    mockFetchJson(health);
    render(<App />);
    expect(screen.getByRole('status')).toHaveTextContent('Connecting to the TaxDesk service…');
  });

  it('shows service health after a successful API response', async () => {
    mockFetchJson(health);
    render(<App />);
    expect(await screen.findByText('Service status')).toBeInTheDocument();
    expect(
      screen.getByText('TaxDesk is connected to the staging environment.'),
    ).toBeInTheDocument();
    expect(screen.getByText('1.2.3')).toBeInTheDocument();
    expect(screen.getByText('req-health')).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith('/health', {
      headers: { Accept: 'application/json' },
    });
  });

  it('shows a friendly error and reference ID when the health call fails', async () => {
    mockFetchJson(
      {
        type: 'https://taxdesk.app/problems/internal-error',
        title: 'Internal Server Error',
        status: 500,
        code: 'INTERNAL_ERROR',
        detail: 'The server could not complete the request. Please try again later.',
        requestId: 'req-failed',
      },
      { status: 500, headers: { 'X-Request-Id': 'req-failed' } },
    );
    render(<App />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('TaxDesk is temporarily unavailable');
    expect(alert).toHaveTextContent(
      'We could not reach the TaxDesk service. Check your connection and try again.',
    );
    expect(alert).toHaveTextContent('Reference ID: req-failed');
    expect(alert).not.toHaveTextContent('Internal Server Error');
  });

  it('shows the generic friendly error when the response violates the contract', async () => {
    mockFetchJson({ environment: 'invalid' });
    render(<App />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'TaxDesk is temporarily unavailable',
    );
  });

  it('retries the health call from the error state', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 503 }))
        .mockResolvedValueOnce(createJsonResponse(health)),
    );
    render(<App />);

    const alert = await screen.findByRole('alert');
    expect(alert).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByText('Service status')).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('has no serious accessibility violations in success and error states', async () => {
    mockFetchJson(health);
    const successRender = render(<App />);
    await screen.findByText('Service status');
    const successResults = await axe(successRender.container);
    expect(
      successResults.violations.filter(
        (violation) => violation.impact === 'serious' || violation.impact === 'critical',
      ),
    ).toHaveLength(0);
    successRender.unmount();

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 500 })));
    const errorRender = render(<App />);
    await screen.findByRole('alert');
    const errorResults = await axe(errorRender.container);
    expect(
      errorResults.violations.filter(
        (violation) => violation.impact === 'serious' || violation.impact === 'critical',
      ),
    ).toHaveLength(0);
  });
});
