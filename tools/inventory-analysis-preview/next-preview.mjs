import {realpathSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const app = realpathSync(dirname(fileURLToPath(import.meta.url)));
process.chdir(app);
process.env.NEXT_TELEMETRY_DISABLED = '1';
const require = createRequire(import.meta.url);
const command = process.argv[2] ?? 'dev';
if (!['dev','build','start'].includes(command)) throw new Error('Unsupported preview command');
const executable = require.resolve('next/dist/bin/next');
const args = command === 'build' ? [] : ['--hostname','127.0.0.1',...process.argv.slice(3)];
process.argv = [process.execPath,executable,command,...args];
require(executable);
