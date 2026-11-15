import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const from = join(root, 'src', 'store', 'sqlite', 'migrations');
const to = join(root, 'dist', 'src', 'store', 'sqlite', 'migrations');
mkdirSync(to, { recursive: true });
cpSync(from, to, { recursive: true });
