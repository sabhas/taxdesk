import { pathToFileURL } from 'node:url';
import { createPrompt } from './prompt.js';
import { runBootstrapCli } from './bootstrap-cli.js';
import { createCliServices } from './services.js';

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const prompt = createPrompt(process.stdin, process.stdout);
  return await runBootstrapCli({
    argv,
    env: process.env,
    prompt,
    stdout: (line) => {
      process.stdout.write(`${line}\n`);
    },
    stderr: (line) => {
      process.stderr.write(`${line}\n`);
    },
    now: () => new Date(),
    createServices: (databaseUrl) => createCliServices(databaseUrl),
  });
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  process.exitCode = await main();
}
