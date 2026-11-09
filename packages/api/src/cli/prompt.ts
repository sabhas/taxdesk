import { createInterface } from 'node:readline/promises';
import { Writable, type Readable } from 'node:stream';

export interface Prompt {
  ask(question: string, defaultValue?: string): Promise<string>;
  askSecret(question: string): Promise<string>;
  close(): void;
}

/**
 * Forwards readline's output to the real terminal except while muted. Secrets
 * are read by the same readline interface as every other answer, with its echo
 * (typed characters, cursor redraws) swallowed here. A second reader on stdin
 * would race readline for keystrokes, and readline would echo the secret.
 */
class MutableOutput extends Writable {
  muted = false;

  constructor(private readonly target: Writable & { isTTY?: boolean; columns?: number }) {
    super();
  }

  get isTTY(): boolean {
    return this.target.isTTY === true;
  }

  get columns(): number | undefined {
    return this.target.columns;
  }

  override _write(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (!this.muted) {
      this.target.write(chunk, encoding);
    }
    callback();
  }
}

/**
 * Interactive prompt for the operator CLIs. Secrets are never echoed: on a TTY
 * the terminal shows nothing while the secret is typed, and a piped invocation
 * reads a line without printing it, so the command stays scriptable.
 */
export function createPrompt(
  input: Readable & { isTTY?: boolean },
  output: Writable & { isTTY?: boolean; columns?: number },
): Prompt {
  const mutable = new MutableOutput(output);
  const readline = createInterface({
    input,
    output: mutable,
    terminal: input.isTTY === true && output.isTTY === true,
  });

  return {
    async ask(question, defaultValue) {
      const suffix = defaultValue === undefined ? '' : ` [${defaultValue}]`;
      const answer = (await readline.question(`${question}${suffix}: `)).trim();
      return answer.length === 0 ? (defaultValue ?? '') : answer;
    },
    async askSecret(question) {
      output.write(`${question}: `);
      mutable.muted = true;
      try {
        return await readline.question('');
      } finally {
        mutable.muted = false;
        output.write('\n');
      }
    },
    close() {
      readline.close();
    },
  };
}
