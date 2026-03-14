/**
 * Google Drive host-side proxy service for NanoClaw.
 *
 * All rclone operations are serialized through a mutex to prevent
 * OAuth refresh token race conditions. Credentials never leave the host.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';

import { RCLONE_CONF_PATH } from './config.js';
import { logger } from './logger.js';

const execFileAsync = promisify(execFile);

// Simple mutex: queue of waiting resolvers
let mutexQueue: Array<() => void> = [];
let mutexLocked = false;

async function acquireMutex(): Promise<void> {
  if (!mutexLocked) {
    mutexLocked = true;
    return;
  }
  return new Promise((resolve) => {
    mutexQueue.push(resolve);
  });
}

function releaseMutex(): void {
  const next = mutexQueue.shift();
  if (next) {
    next();
  } else {
    mutexLocked = false;
  }
}

const RCLONE_TIMEOUT = 60_000; // 60s per operation

async function rclone(args: string[]): Promise<string> {
  await acquireMutex();
  try {
    const { stdout } = await execFileAsync(
      'rclone',
      ['--config', RCLONE_CONF_PATH, ...args],
      { timeout: RCLONE_TIMEOUT },
    );
    return stdout;
  } finally {
    releaseMutex();
  }
}

/**
 * Validate and normalize a remote path to prevent traversal.
 * Returns the cleaned path or throws on invalid input.
 */
function sanitizePath(remotePath: string): string {
  // Remove leading/trailing whitespace and slashes
  const cleaned = remotePath.replace(/^\/+|\/+$/g, '');
  // Block path traversal
  if (cleaned.includes('..') || cleaned.includes('\0')) {
    throw new Error('Invalid path: traversal not allowed');
  }
  return cleaned;
}

export interface GDriveListResult {
  files: Array<{ path: string; size: number; modTime: string; isDir: boolean }>;
}

export async function listFiles(remotePath: string): Promise<GDriveListResult> {
  const cleanPath = sanitizePath(remotePath);
  const remote = cleanPath ? `gdrive:${cleanPath}` : 'gdrive:';

  try {
    const output = await rclone(['lsjson', remote]);
    const items = JSON.parse(output) as Array<{
      Path: string;
      Size: number;
      ModTime: string;
      IsDir: boolean;
    }>;
    return {
      files: items.map((item) => ({
        path: item.Path,
        size: item.Size,
        modTime: item.ModTime,
        isDir: item.IsDir,
      })),
    };
  } catch (err) {
    logger.error({ err, remotePath }, 'GDrive list failed');
    throw new Error(
      `GDrive list failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function downloadFile(
  remotePath: string,
  localPath: string,
): Promise<void> {
  const cleanPath = sanitizePath(remotePath);

  try {
    await rclone(['copyto', `gdrive:${cleanPath}`, localPath]);
  } catch (err) {
    logger.error({ err, remotePath, localPath }, 'GDrive download failed');
    throw new Error(
      `GDrive download failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function uploadFile(
  localPath: string,
  remotePath: string,
): Promise<void> {
  const cleanPath = sanitizePath(remotePath);

  try {
    await rclone(['copyto', localPath, `gdrive:${cleanPath}`]);
  } catch (err) {
    logger.error({ err, localPath, remotePath }, 'GDrive upload failed');
    throw new Error(
      `GDrive upload failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
