import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { ScriptPathSchema } from './protocol';

export const MAX_SCRIPT_BYTES = 1024 * 1024;

export type ScriptErrorCode = 'invalid_script_path' | 'script_not_found' | 'script_hash_mismatch';

export class ScriptError extends Error {
  constructor(
    readonly code: ScriptErrorCode,
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'ScriptError';
  }
}

export interface ResolvedScript {
  /** Normalised relative path (forward slashes). */
  path: string;
  absolutePath: string;
  sha256: string;
  /** UTF-8 text without BOM — exactly the bytes that were hashed. The worker runs this, not the file. */
  content: string;
}

/**
 * Resolves a pinned script under the scripts directory and verifies its sha256.
 * 400 invalid path / escapes the directory (including via symlinks), 404 missing, 409 hash mismatch.
 */
export async function resolveScript(
  scriptsDir: string,
  relPath: string,
  expectedSha256: string,
): Promise<ResolvedScript> {
  if (
    !ScriptPathSchema.safeParse(relPath).success ||
    relPath.split('/').some((s) => s === '' || s === '.' || s === '..')
  ) {
    throw new ScriptError(
      'invalid_script_path',
      400,
      'Script path must be a relative path like exchange/Get-Thing.ps1',
    );
  }
  let root: string;
  try {
    root = await realpath(scriptsDir);
  } catch {
    throw new ScriptError('script_not_found', 404, 'The scripts directory does not exist on the runner');
  }
  const candidate = path.resolve(root, relPath);
  if (!isInside(root, candidate))
    throw new ScriptError('invalid_script_path', 400, 'Script path escapes the scripts directory');

  let real: string;
  try {
    real = await realpath(candidate);
  } catch {
    throw new ScriptError('script_not_found', 404, `Script ${relPath} does not exist on the runner`);
  }
  if (!isInside(root, real))
    throw new ScriptError('invalid_script_path', 400, 'Script path escapes the scripts directory');
  const info = await stat(real);
  if (!info.isFile()) throw new ScriptError('script_not_found', 404, `Script ${relPath} is not a file`);
  if (info.size > MAX_SCRIPT_BYTES)
    throw new ScriptError('invalid_script_path', 400, `Script ${relPath} is larger than 1 MiB`);

  const bytes = await readFile(real);
  const actual = createHash('sha256').update(bytes).digest('hex');
  const a = Buffer.from(actual, 'hex');
  const b = Buffer.from(expectedSha256.toLowerCase(), 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new ScriptError(
      'script_hash_mismatch',
      409,
      `Script ${relPath} does not match the pinned sha256; refusing to run it`,
    );
  }
  const text = bytes.toString('utf8');
  return {
    path: relPath,
    absolutePath: real,
    sha256: actual,
    content: text.charCodeAt(0) === 0xfeff ? text.slice(1) : text,
  };
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}
