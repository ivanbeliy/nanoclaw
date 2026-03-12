# OAuth Authentication & Session Size Fix (2026-03-12)

## Problem

Container agents (Chuck/WhiteClaw on Discord) stopped responding. Containers exited with code 137 (SIGKILL) on every attempt, with retry backoff escalating until max retries were exceeded.

## Root Causes

Three independent issues stacked on top of each other, each masking the next:

### 1. Stale OAuth credential proxy

**Symptom:** Container exits with auth errors or uses "placeholder" as a real token.

The credential proxy was designed for an older Claude Agent SDK that exchanged OAuth tokens via `create_api_key`. SDK v0.2.68+ reads credentials directly from `~/.claude/.credentials.json` and manages token refresh natively.

The old code set these env vars for ALL auth modes:
```
ANTHROPIC_BASE_URL=http://host.docker.internal:3001  (proxy)
CLAUDE_CODE_OAUTH_TOKEN=placeholder
```

In OAuth mode, this caused the SDK to send "placeholder" as a real bearer token → 401.

**Fix (`src/container-runner.ts` → `buildContainerArgs()`):**
- API key mode: keep proxy (`ANTHROPIC_BASE_URL` + `ANTHROPIC_API_KEY=placeholder`)
- OAuth mode: do NOT set `ANTHROPIC_BASE_URL` or token env vars. Let SDK use real credentials from the mounted `.credentials.json`.

### 2. File permissions on credential copy

**Symptom:** SDK logs "Not logged in" despite `.credentials.json` existing.

The host copies `~/.claude/.credentials.json` into the container's bind-mounted `.claude/` directory. The file inherits root:root ownership, but the container runs as `node` (uid 1000) and can't read it.

**Fix (`src/container-runner.ts` → `runContainerAgent()`):**
```typescript
fs.copyFileSync(hostCreds, containerCreds);
fs.chownSync(containerCreds, 1000, 1000);  // readable by container's node user
fs.chmodSync(containerCreds, 0o600);
```

### 3. Unbounded session transcript growth

**Symptom:** Exit code 137 (SIGKILL). Container killed ~3-15s after start, even with correct auth. Manual tests with new sessions work fine.

Session `be0187c8` grew to 2.1MB (normal: 4-12KB). When resuming, the SDK loads the full transcript into memory. The loading phase consumed enough resources that the container was killed by the OOM killer or timed out during initialization.

**Immediate fix:** Cleared the corrupted session from SQLite:
```sql
DELETE FROM sessions WHERE group_folder='discord_main';
```

**Systemic fix (`src/index.ts` → `runAgent()`):**
```typescript
// Before resuming, check transcript file size
const stat = fs.statSync(sessionFile);
if (stat.size > 500 * 1024) {
  sessionId = undefined;  // start fresh
}
```

## Debugging Timeline

| Step | Action | Finding |
|------|--------|---------|
| 1 | Check `git diff` | Recent changes were formatting-only, not functional |
| 2 | Check logs (`/tmp/nanoclaw.log`) | Containers dying with exit code 137, retry backoff escalating |
| 3 | Check system memory, kernel OOM | 7.8GB available, no OOM events in dmesg |
| 4 | Read container logs | Container used proxy URL, agent-runner initialized OK, then killed |
| 5 | Test credential proxy | Proxy forwarded to Anthropic correctly (got proper 401) |
| 6 | Test OAuth `create_api_key` | 403: OAuth token lacks `org:create_api_key` scope |
| 7 | Check SDK version | v0.2.68 — no longer uses `create_api_key` exchange |
| 8 | Fix auth: remove proxy redirect for OAuth, copy `.credentials.json` | Auth now succeeds, API stream starts |
| 9 | Fix permissions: `chown 1000:1000` on copied credentials | SDK no longer reports "Not logged in" |
| 10 | Still 137 — add `STOP-TRACE` to `stopContainer()` | NanoClaw is NOT killing its own containers |
| 11 | Check Docker stats, OOM | 260MB usage, OOMKilled=false |
| 12 | Manual container test | Works perfectly — key difference: new session vs resumed |
| 13 | Compare sessions | `be0187c8` = 2.1MB, others = 4-12KB |
| 14 | Clear corrupted session from DB | Containers now start and respond successfully |
| 15 | Add session size guard | Prevents future recurrence |

## Key Insight

Three independent failures stacked: auth mechanism change → file permissions → session corruption. Each fix only revealed the next layer, making it appear circular until all three were resolved.

## Files Changed

| File | Change |
|------|--------|
| `src/container-runner.ts` | OAuth-aware auth in `buildContainerArgs()`; credential sync with correct permissions in `runContainerAgent()` |
| `src/container-runtime.ts` | Removed `[STOP-TRACE]` debug logging |
| `src/index.ts` | Session size guard (>500KB → fresh session) in `runAgent()` |
