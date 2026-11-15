import { readFile, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import type { FileContentBlock, ImageContentBlock } from './types.js';
import { DomainError } from './errors.js';

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.ts': 'text/typescript',
  '.tsx': 'text/tsx',
  '.js': 'text/javascript',
  '.jsx': 'text/jsx',
  '.py': 'text/x-python',
  '.sql': 'application/sql',
  '.csv': 'text/csv',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.html': 'text/html',
  '.css': 'text/css',
  '.pdf': 'application/pdf',
};

const TEXT_MIME_PREFIXES = ['text/'];
const TEXT_MIME_EXACT = new Set([
  'application/json',
  'application/sql',
  'application/yaml',
  'application/xml',
  'image/svg+xml',
]);

export function inferMimeType(filePath: string, fallback = 'application/octet-stream'): string {
  const ext = extname(filePath).toLowerCase();
  return MIME_BY_EXT[ext] ?? fallback;
}

function isTextMime(mimeType: string): boolean {
  return TEXT_MIME_PREFIXES.some((prefix) => mimeType.startsWith(prefix)) || TEXT_MIME_EXACT.has(mimeType);
}

export async function imageBlockFromFile(
  filePath: string,
  opts?: { mimeType?: string; alt?: string; maxBytes?: number }
): Promise<ImageContentBlock> {
  const maxBytes = opts?.maxBytes ?? 10 * 1024 * 1024;
  const info = await stat(filePath);
  if (info.size > maxBytes) {
    throw new DomainError(
      `Image attachment ${basename(filePath)} (${info.size} bytes) exceeds limit (${maxBytes} bytes)`,
      'ATTACHMENT_TOO_LARGE'
    );
  }
  const buffer = await readFile(filePath);
  const mimeType = opts?.mimeType ?? inferMimeType(filePath, 'image/png');
  return {
    type: 'image',
    mimeType,
    data: buffer.toString('base64'),
    alt: opts?.alt ?? basename(filePath),
    sizeBytes: buffer.byteLength,
  };
}

export async function fileBlockFromPath(
  filePath: string,
  opts?: { mimeType?: string; maxBytes?: number; maxTextChars?: number }
): Promise<FileContentBlock> {
  const maxBytes = opts?.maxBytes ?? 5 * 1024 * 1024;
  const maxTextChars = opts?.maxTextChars ?? 50_000;
  const info = await stat(filePath);
  if (info.size > maxBytes) {
    throw new DomainError(
      `File attachment ${basename(filePath)} (${info.size} bytes) exceeds limit (${maxBytes} bytes)`,
      'ATTACHMENT_TOO_LARGE'
    );
  }
  const buffer = await readFile(filePath);
  const mimeType = opts?.mimeType ?? inferMimeType(filePath);
  const name = basename(filePath);

  if (isTextMime(mimeType)) {
    let text = buffer.toString('utf-8');
    if (text.length > maxTextChars) {
      text = `${text.slice(0, maxTextChars)}\n... [Truncated ${text.length - maxTextChars} chars]`;
    }
    return {
      type: 'file',
      name,
      mimeType,
      text,
      path: filePath,
      sizeBytes: buffer.byteLength,
    };
  }

  return {
    type: 'file',
    name,
    mimeType,
    data: buffer.toString('base64'),
    path: filePath,
    sizeBytes: buffer.byteLength,
  };
}
