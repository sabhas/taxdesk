import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createPrompt } from './prompt.js';

function terminalPair(tty: boolean) {
  const input = Object.assign(new PassThrough(), { isTTY: tty });
  const written: string[] = [];
  const output = Object.assign(new PassThrough(), { isTTY: tty, columns: 80 });
  output.on('data', (chunk: Buffer) => written.push(chunk.toString('utf8')));
  return { input, output, written: () => written.join('') };
}

describe.each([true, false])('createPrompt (tty: %s)', (tty) => {
  it('never echoes a secret and still echoes ordinary answers', async () => {
    const { input, output, written } = terminalPair(tty);
    const prompt = createPrompt(input, output);

    const email = prompt.ask('Administrator email');
    input.write('owner@example.test\r\n');
    await expect(email).resolves.toBe('owner@example.test');

    const secret = prompt.askSecret('Password');
    input.write('hunter2 is not a password\r\n');
    await expect(secret).resolves.toBe('hunter2 is not a password');

    const confirmation = prompt.askSecret('Confirm password');
    input.write('hunter2 is not a password\r\n');
    await expect(confirmation).resolves.toBe('hunter2 is not a password');
    prompt.close();

    const shown = written();
    expect(shown).toContain('Password: ');
    expect(shown).toContain('Confirm password: ');
    expect(shown).not.toContain('hunter2');
  });
});
