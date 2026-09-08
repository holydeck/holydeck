import { defaultContext } from './context.js';
import { installInterruptHandlers } from './interrupt.js';
import { runCli } from './program.js';

const ctx = defaultContext();
ctx.abortSignal = installInterruptHandlers(process, (line) => {
  process.stderr.write(`${line}\n`);
});

process.exitCode = await runCli(ctx, process.argv.slice(2));
