import { describe, expect, it } from 'vitest';
import { runBootstrapCli } from './bootstrap-cli.js';
import { runRecoveryCli } from './recover-cli.js';
import type { Prompt } from './prompt.js';
import type { CliServices } from './services.js';

interface FakePrompt extends Prompt {
  readonly asked: string[];
  readonly secrets: string[];
}

function fakePrompt(answers: readonly string[], secrets: readonly string[] = []): FakePrompt {
  const asked: string[] = [];
  const secretsAsked: string[] = [];
  const answersQueue = [...answers];
  const secretsQueue = [...secrets];
  return {
    asked,
    secrets: secretsAsked,
    ask: async (question) => {
      asked.push(question);
      return answersQueue.shift() ?? '';
    },
    askSecret: async (question) => {
      secretsAsked.push(question);
      return secretsQueue.shift() ?? '';
    },
    close: () => undefined,
  };
}

interface Recorder {
  readonly stdout: string[];
  readonly stderr: string[];
}

function recorder(): Recorder {
  return { stdout: [], stderr: [] };
}

function services(
  overrides: {
    bootstrap?: (input: unknown) => Promise<{ firmId: string; userId: string }>;
    resetPassword?: (email: string, password: string) => Promise<void>;
    disableMfa?: (email: string) => Promise<void>;
    reactivate?: (email: string) => Promise<void>;
  } = {},
): { value: CliServices; closed: () => boolean } {
  let closed = false;
  const value = {
    bootstrap: {
      bootstrap: overrides.bootstrap ?? (async () => ({ firmId: 'firm-1', userId: 'user-1' })),
    },
    recovery: {
      resetPassword: overrides.resetPassword ?? (() => Promise.resolve()),
      disableMfa: overrides.disableMfa ?? (() => Promise.resolve()),
      reactivate: overrides.reactivate ?? (() => Promise.resolve()),
    },
    close: async () => {
      closed = true;
    },
  } as unknown as CliServices;
  return { value, closed: () => closed };
}

const env = { DATABASE_URL: 'postgres://example/test_test?sslmode=disable' };

describe('bootstrap CLI', () => {
  it('prints usage and succeeds', async () => {
    const io = recorder();
    const code = await runBootstrapCli({
      argv: ['--help'],
      env,
      prompt: fakePrompt([]),
      stdout: (line) => io.stdout.push(line),
      stderr: (line) => io.stderr.push(line),
      now: () => new Date('2026-01-01T00:00:00Z'),
      createServices: () => services().value,
    });
    expect(code).toBe(0);
    expect(io.stdout.join('\n')).toContain('first-administrator bootstrap');
  });

  it('requires all values in non-interactive mode', async () => {
    const io = recorder();
    const code = await runBootstrapCli({
      argv: ['--non-interactive', '--email', 'owner@example.test'],
      env,
      prompt: fakePrompt([]),
      stdout: (line) => io.stdout.push(line),
      stderr: (line) => io.stderr.push(line),
      now: () => new Date('2026-01-01T00:00:00Z'),
      createServices: () => services().value,
    });
    expect(code).toBe(2);
    expect(io.stderr.join('\n')).toContain('--firm-name');
  });

  it('creates the first administrator without printing the password', async () => {
    const io = recorder();
    const created = services();
    let received: Record<string, unknown> | undefined;
    const code = await runBootstrapCli({
      argv: [
        '--non-interactive',
        '--firm-name',
        'Example Firm',
        '--email',
        'Owner@Example.test',
        '--display-name',
        'Owner',
        '--password',
        'correct horse battery staple',
      ],
      env,
      prompt: fakePrompt([]),
      stdout: (line) => io.stdout.push(line),
      stderr: (line) => io.stderr.push(line),
      now: () => new Date('2026-01-01T00:00:00Z'),
      createServices: () => {
        return {
          ...created.value,
          bootstrap: {
            bootstrap: async (input: unknown) => {
              received = input as Record<string, unknown>;
              return { firmId: 'firm-1', userId: 'user-1' };
            },
          },
        } as unknown as CliServices;
      },
    });
    expect(code).toBe(0);
    expect(received?.['email']).toBe('Owner@Example.test');
    const output = io.stdout.join('\n');
    expect(output).toContain('"status":"created"');
    expect(output).not.toContain('correct horse battery staple');
    expect(created.closed()).toBe(true);
  });

  it('prompts for missing values and rejects a password mismatch', async () => {
    const io = recorder();
    const code = await runBootstrapCli({
      argv: [],
      env,
      prompt: fakePrompt(
        ['Example Firm', 'owner@example.test', 'Owner'],
        ['correct horse battery staple', 'different value here'],
      ),
      stdout: (line) => io.stdout.push(line),
      stderr: (line) => io.stderr.push(line),
      now: () => new Date('2026-01-01T00:00:00Z'),
      createServices: () => services().value,
    });
    expect(code).toBe(2);
    expect(io.stderr.join('\n')).toContain('do not match');
  });

  it('re-asks an invalid email instead of failing after the password prompts', async () => {
    const io = recorder();
    const created = services();
    const prompt = fakePrompt(
      ['Example Firm', 'owner', 'owner@example.test', 'Owner'],
      ['correct horse battery staple', 'correct horse battery staple'],
    );
    const code = await runBootstrapCli({
      argv: [],
      env,
      prompt,
      stdout: (line) => io.stdout.push(line),
      stderr: (line) => io.stderr.push(line),
      now: () => new Date('2026-01-01T00:00:00Z'),
      createServices: () => created.value,
    });
    expect(code).toBe(0);
    expect(io.stderr.join('\n')).toContain('valid email address');
    expect(prompt.asked).toEqual([
      'Firm name',
      'Administrator email',
      'Administrator email',
      'Administrator display name',
    ]);
    expect(io.stdout.join('\n')).toContain('"status":"created"');
  });

  it('refuses to run without a database URL', async () => {
    const io = recorder();
    const code = await runBootstrapCli({
      argv: [],
      env: {},
      prompt: fakePrompt([]),
      stdout: (line) => io.stdout.push(line),
      stderr: (line) => io.stderr.push(line),
      now: () => new Date(),
      createServices: () => services().value,
    });
    expect(code).toBe(2);
    expect(io.stderr.join('\n')).toContain('DATABASE_URL');
  });
});

describe('recovery CLI', () => {
  it('requires an exact confirmation in non-interactive mode', async () => {
    const io = recorder();
    const code = await runRecoveryCli({
      argv: [
        '--non-interactive',
        '--email',
        'person@example.test',
        '--action',
        'reactivate',
        '--confirm',
        'someone-else@example.test',
      ],
      env,
      prompt: fakePrompt([]),
      stdout: (line) => io.stdout.push(line),
      stderr: (line) => io.stderr.push(line),
      now: () => new Date(),
      createServices: () => services().value,
    });
    expect(code).toBe(2);
    expect(io.stderr.join('\n')).toContain('--confirm');
  });

  it('runs a password reset and reports completion without the secret', async () => {
    const io = recorder();
    let reset: { email: string; password: string } | undefined;
    const fake = services({
      resetPassword: async (email, password) => {
        reset = { email, password };
      },
    });
    const code = await runRecoveryCli({
      argv: [
        '--non-interactive',
        '--email',
        'person@example.test',
        '--action',
        'reset-password',
        '--password',
        'another correct horse battery',
        '--confirm',
        'person@example.test',
      ],
      env,
      prompt: fakePrompt([]),
      stdout: (line) => io.stdout.push(line),
      stderr: (line) => io.stderr.push(line),
      now: () => new Date(),
      createServices: () => fake.value,
    });
    expect(code).toBe(0);
    expect(reset?.email).toBe('person@example.test');
    expect(io.stdout.join('\n')).toContain('"action":"reset-password"');
    expect(io.stdout.join('\n')).not.toContain('another correct horse battery');
    expect(fake.closed()).toBe(true);
  });

  it('rejects an unknown action', async () => {
    const io = recorder();
    const code = await runRecoveryCli({
      argv: [
        '--non-interactive',
        '--email',
        'person@example.test',
        '--action',
        'delete-everything',
      ],
      env,
      prompt: fakePrompt([]),
      stdout: (line) => io.stdout.push(line),
      stderr: (line) => io.stderr.push(line),
      now: () => new Date(),
      createServices: () => services().value,
    });
    expect(code).toBe(2);
    expect(io.stderr.join('\n')).toContain('--action');
  });
});
