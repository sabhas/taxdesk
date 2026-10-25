import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { axe } from 'vitest-axe';
import { mockFetchJson } from '@taxdesk/test-utils';
import { App } from './App.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('App', () => {
  it('shows a loading state before the API responds', () => {
    mockFetchJson({ name: 'TaxDesk API', version: '0.0.0', environment: 'development' });
    render(<App />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading application information…');
  });

  it('shows app information after a successful API response', async () => {
    mockFetchJson({ name: 'TaxDesk API', version: '1.2.3', environment: 'staging' });
    render(<App />);
    expect(await screen.findByText('TaxDesk API')).toBeInTheDocument();
    expect(screen.getByText('1.2.3')).toBeInTheDocument();
    expect(screen.getByText('staging')).toBeInTheDocument();
  });

  it('shows an error when the API request fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 500 })));
    render(<App />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Unable to load application information.',
    );
    expect(screen.getByText('API request failed with status 500')).toBeInTheDocument();
  });

  it('shows an error when the API response violates the contract', async () => {
    mockFetchJson({ name: 'TaxDesk API', version: '0.0.0', environment: 'invalid' });
    render(<App />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Unable to load application information.',
    );
    expect(
      screen.getByText('API response did not match the expected contract'),
    ).toBeInTheDocument();
  });

  it('has no serious accessibility violations', async () => {
    mockFetchJson({ name: 'TaxDesk API', version: '1.0.0', environment: 'development' });
    const { container } = render(<App />);
    await screen.findByText('TaxDesk API');
    const results = await axe(container);
    const seriousViolations = results.violations.filter(
      (violation) => violation.impact === 'serious' || violation.impact === 'critical',
    );
    expect(seriousViolations).toHaveLength(0);
  });
});
