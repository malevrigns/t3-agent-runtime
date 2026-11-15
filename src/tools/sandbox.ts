import os from 'node:os';
import path from 'node:path';
import { realpathSync } from 'node:fs';

/** Pi-style permission modes. `build` is the everyday coding mode. */
export type SandboxMode = 'default' | 'build' | 'plan' | 'yolo';

const PROTECTED_DIRS = new Set(['.git', 'node_modules', '.vscode', '.idea', '.ssh']);
const PROTECTED_FILES = new Set([
  '.gitconfig',
  '.gitmodules',
  '.npmrc',
  '.bashrc',
  '.bash_profile',
  '.zshrc',
  '.zprofile',
  '.profile',
  '.ripgreprc',
  '.envrc',
]);

export function parseSandboxMode(value: string | undefined): SandboxMode | null {
  if (value === 'default' || value === 'build' || value === 'plan' || value === 'yolo') return value;
  return null;
}

export function expandHome(input: string): string {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/') || input.startsWith('~\\')) return path.join(os.homedir(), input.slice(2));
  return input;
}

function existingCanonical(absolute: string): string {
  let current = absolute;
  const tail: string[] = [];
  for (let i = 0; i < 32; i++) {
    try {
      const real = realpathSync(current);
      return tail.length === 0 ? real : path.resolve(real, ...tail.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(absolute);
      tail.push(path.basename(current));
      current = parent;
    }
  }
  return path.resolve(absolute);
}

function isTemplateEnv(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === '.env.example' || lower === '.env.sample' || lower === '.env.template';
}

function isSecretFile(name: string): boolean {
  const lower = name.toLowerCase();
  if (isTemplateEnv(lower)) return false;
  if (lower === '.env' || lower.startsWith('.env.')) return true;
  return lower.endsWith('.pem') || lower.endsWith('.key');
}

export interface ResolvedPath {
  input: string;
  absolute: string;
  outside: boolean;
  /** Hard-blocked for write, edit, and delete. */
  protectedWrite: boolean;
  /** Credentials. Reads ask; writes are protected. */
  secret: boolean;
}

export function resolveProjectPath(projectRoot: string, input: string): ResolvedPath {
  const expanded = expandHome(input.trim() || '.');
  const absolute = existingCanonical(path.resolve(projectRoot, expanded));
  const root = existingCanonical(path.resolve(projectRoot));
  const rel = path.relative(root, absolute);
  const outside = rel.startsWith('..') || path.isAbsolute(rel);
  const segments = absolute.split(/[\\/]+/).filter(Boolean);
  const base = (segments[segments.length - 1] ?? '').toLowerCase();
  const secret = isSecretFile(base) || segments.some((segment) => segment.toLowerCase() === '.ssh');
  const protectedWrite =
    secret ||
    segments.some((segment) => PROTECTED_DIRS.has(segment.toLowerCase())) ||
    PROTECTED_FILES.has(base);
  return { input, absolute, outside, protectedWrite, secret };
}

export interface CommandInspection {
  empty: boolean;
  catastrophic: boolean;
  dangerous: boolean;
  outside: boolean;
  protectedWrite: boolean;
  secret: boolean;
  /** A nested shell hides the real command, so the policy asks instead of allowing it. */
  opaque: boolean;
}

function isCatastrophic(command: string): boolean {
  const lowered = command.toLowerCase();
  if (/\bsudo\b/.test(lowered)) return true;
  if (/\b(shutdown|reboot|mkfs)\b/.test(lowered)) return true;
  if (/\bformat\s+[a-z]:/.test(lowered)) return true;
  if (/\bdd\s+if=/.test(lowered)) return true;
  if (/\b(curl|wget)\b[\s\S]{0,240}\|\s*(sh|bash|powershell)\b/.test(lowered)) return true;
  if (/\brm\s+-[a-z]*r[a-z]*\s+(['"]?)(\/(\*)?|~(\/\*)?)\1(\s|$)/.test(lowered)) return true;
  return false;
}

function looksLikePath(value: string): boolean {
  if (!value || (value.startsWith('-') && !value.includes('='))) return false;
  const target = value.includes('=') && value.startsWith('-') ? value.slice(value.indexOf('=') + 1) : value;
  if (!target) return false;
  if (target.startsWith('~/') || target === '~' || target.startsWith('/') || target.startsWith('./') || target.startsWith('../') || target === '..') {
    return true;
  }
  if (/^[A-Za-z]:[\\/]/.test(target)) return true;
  if (target.includes('..') || target.includes('/') || target.includes('\\')) return true;
  const base = target.split(/[\\/]/).pop()?.toLowerCase() ?? '';
  if (base.startsWith('.env') || base === '.git' || base === '.ssh' || base.endsWith('.pem') || base.endsWith('.key')) return true;
  return false;
}

function pathTokens(command: string): string[] {
  const withRedirects = command.replace(/(^|[\s;|&])(>>?)\s*(\S+)/g, ' $3 ');
  const out: string[] = [];
  for (const token of withRedirects.split(/\s+/)) {
    const cleaned = token.replace(/^['"]+|['"]+$/g, '').replace(/[;,]+$/g, '');
    if (!looksLikePath(cleaned)) continue;
    const value = cleaned.startsWith('-') && cleaned.includes('=') ? cleaned.slice(cleaned.indexOf('=') + 1) : cleaned;
    if (value) out.push(value);
  }
  return out;
}

const WRITEISH = /\b(rm|del|rmdir|mv|move|cp|copy|tee|truncate|sed|remove-item|set-content|out-file|new-item)\b|(^|[\s;|&])>>?\s*\S/i;

export function inspectCommand(command: string, projectRoot: string): CommandInspection {
  const trimmed = command.trim();
  if (!trimmed) {
    return { empty: true, catastrophic: false, dangerous: false, outside: false, protectedWrite: false, secret: false, opaque: false };
  }
  const catastrophic = isCatastrophic(trimmed);
  const opaque = /\b(bash|sh|pwsh|powershell|cmd)(\.exe)?\s+(-c|-e|-command|-encodedcommand)\b|\biex\b|\binvoke-expression\b/i.test(trimmed);
  const dangerous = /\brm\s+-/i.test(trimmed)
    || /\bremove-item\b[\s\S]*-recurse/i.test(trimmed)
    || /\bgit\s+push\b/i.test(trimmed)
    || /\bnpm\s+publish\b/i.test(trimmed)
    || /\bdel\s+\/s/i.test(trimmed);
  const writeish = WRITEISH.test(trimmed);
  let outside = false;
  let protectedWrite = false;
  let secret = false;
  for (const token of pathTokens(trimmed)) {
    const resolved = resolveProjectPath(projectRoot, token);
    if (resolved.outside) outside = true;
    if (resolved.secret) secret = true;
    if (resolved.protectedWrite && writeish) protectedWrite = true;
  }
  return { empty: false, catastrophic, dangerous, outside, protectedWrite, secret, opaque };
}
