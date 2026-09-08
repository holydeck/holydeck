import { defaultContext } from './context.js';
import { runCli } from './program.js';

process.exitCode = await runCli(defaultContext(), process.argv.slice(2));
