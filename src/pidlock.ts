/**
 * PID lock file to prevent multiple NanoClaw instances from running.
 *
 * When two instances run simultaneously, each kills the other's containers
 * via cleanupOrphans(), causing exit code 137 loops.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

const LOCK_FILE = path.join(DATA_DIR, 'nanoclaw.pid');

/**
 * Check if another instance is already running.
 * Returns true if lock acquired, false if another instance holds it.
 */
export function acquirePidLock(): boolean {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const existingPid = parseInt(
        fs.readFileSync(LOCK_FILE, 'utf-8').trim(),
        10,
      );
      if (!isNaN(existingPid) && isProcessRunning(existingPid)) {
        logger.error(
          { existingPid, lockFile: LOCK_FILE },
          'Another NanoClaw instance is already running. Use "systemctl restart nanoclaw" to restart.',
        );
        return false;
      }
      // Stale lock file — previous process died without cleanup
      logger.info({ existingPid }, 'Removing stale PID lock file');
    }
  } catch {
    // Lock file unreadable — treat as stale
  }

  fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true });
  fs.writeFileSync(LOCK_FILE, String(process.pid));
  return true;
}

export function releasePidLock(): void {
  try {
    // Only remove if it's our PID (avoid race with a new instance)
    const content = fs.readFileSync(LOCK_FILE, 'utf-8').trim();
    if (content === String(process.pid)) {
      fs.unlinkSync(LOCK_FILE);
    }
  } catch {
    // Already gone
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
