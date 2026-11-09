import { createInterface } from 'node:readline/promises';
import type { Readable, Writable } from 'node:stream';

export interface Prompt {
  ask(question: string, defaultValue?: string): Promise<string>;
  askSecret(question: string): Promise<string>;
  close(): void;
}

/**
 * Interactive prompt for the operator CLIs. Secrets are read without echo when
 * stdin is a TTY; a piped invocation reads a line so the command stays scriptable
 * without printing the secret.
 */
export function createPrompt(
  input: Readable & { isTTY?: boolean; setRawMode?: (mode: boolean) => void },
  output: Writable,
): Prompt {
  const readline = createInterface({ input, output });

  return {
    async ask(question, defaultValue) {
      const suffix = defaultValue === undefined ? '' : ` [${defaultValue}]`;
      const answer = (await readline.question(`${question}${suffix}: `)).trim();
      return answer.length === 0 ? (defaultValue ?? '') : answer;
    },
    async askSecret(question) {
      if (input.isTTY !== true || typeof input.setRawMode !== 'function') {
        const answer = await readline.question(`${question}: `);
        return answer.trim();
      }

      output.write(`${question}: `);
      input.setRawMode(true);
      input.resume();
      input.setEncoding('utf8');

      return await new Promise<string>((resolve, reject) => {
        let value = '';
        const finish = (error?: Error): void => {
          input.setRawMode?.(false);
          input.pause();
          input.removeListener('data', onData);
          output.write('\n');
          if (error) {
            reject(error);
          } else {
            resolve(value);
          }
        };
        const onData = (chunk: string): void => {
          for (const character of chunk) {
            if (character === '\r' || character === '\n') {
              finish();
              return;
            }
            if (character === '\u0003') {
              finish(new Error('Cancelled.'));
              return;
            }
            if (character === '\u007f') {
              value = value.slice(0, -1);
              continue;
            }
            value += character;
          }
        };
        input.on('data', onData);
      });
    },
    close() {
      readline.close();
    },
  };
}
