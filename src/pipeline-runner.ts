/**
 * Pipeline Runner for NanoClaw
 *
 * Reads pipeline YAML definitions from data/system/pipelines/ and executes
 * multi-stage agent workflows with support for parallel execution.
 *
 * Each stage can run one or more agents. Parallel agents within a stage
 * use git worktrees for isolation, merged back on completion.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { parse as parseYaml } from 'yaml';

import { DATA_DIR } from './config.js';
import { runContainerAgent } from './container-runner.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

export interface PipelineAgent {
  role?: string;
  prompt: string;
  group_suffix: string;
}

export interface PipelineStage {
  name: string;
  parallel?: boolean;
  agents: PipelineAgent[];
}

export interface PipelineDefinition {
  name: string;
  description?: string;
  stages: PipelineStage[];
}

export interface PipelineRunOptions {
  pipelineName: string;
  projectName: string;
  params: Record<string, string>;
  chatJid: string;
  onStatus: (message: string) => Promise<void>;
}

/**
 * Interpolate {param} placeholders in a string.
 */
function interpolate(template: string, params: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key) => params[key] ?? match);
}

/**
 * Run a single pipeline agent in a container.
 */
async function runPipelineAgent(
  agent: PipelineAgent,
  projectDir: string,
  workDir: string,
  params: Record<string, string>,
  chatJid: string,
): Promise<{ status: 'success' | 'error'; result: string | null }> {
  const prompt = interpolate(agent.prompt, params);
  const folder = `pipeline-${agent.group_suffix}`;
  const groupDir = path.join(DATA_DIR, 'sessions', folder);
  fs.mkdirSync(path.join(groupDir, '.claude', 'debug'), { recursive: true });
  try { fs.chownSync(path.join(groupDir, '.claude'), 1000, 1000); } catch { /* ignore */ }

  // Load role definition if specified
  let roleContext = '';
  if (agent.role) {
    const rolePath = path.join(DATA_DIR, 'system', 'roles', `${agent.role}.md`);
    if (fs.existsSync(rolePath)) {
      roleContext = `\n\n## Your Role\n${fs.readFileSync(rolePath, 'utf-8')}\n\n`;
    }
  }

  const fullPrompt = `${roleContext}${prompt}\n\nYour working directory is /workspace/project. Commit your work with descriptive messages.`;

  const group: RegisteredGroup = {
    name: `Pipeline: ${agent.group_suffix}`,
    folder,
    trigger: '',
    added_at: new Date().toISOString(),
    containerConfig: {
      project: path.basename(workDir) === path.basename(projectDir)
        ? path.basename(projectDir)
        : undefined,
    },
  };

  let lastResult: string | null = null;

  const output = await runContainerAgent(
    group,
    {
      prompt: fullPrompt,
      groupFolder: folder,
      chatJid,
      isMain: false,
    },
    (_proc, _containerName) => { /* no queue registration for pipeline agents */ },
    async (result) => {
      if (result.result) {
        lastResult = result.result;
      }
    },
  );

  return {
    status: output.status,
    result: lastResult || output.result,
  };
}

/**
 * Execute a full pipeline.
 */
export async function runPipeline(opts: PipelineRunOptions): Promise<void> {
  const { pipelineName, projectName, params, chatJid, onStatus } = opts;

  // Load pipeline definition
  const pipelinePath = path.join(
    DATA_DIR,
    'system',
    'pipelines',
    `${pipelineName}.yaml`,
  );
  if (!fs.existsSync(pipelinePath)) {
    await onStatus(`Pipeline "${pipelineName}" not found at ${pipelinePath}`);
    return;
  }

  let pipeline: PipelineDefinition;
  try {
    pipeline = parseYaml(fs.readFileSync(pipelinePath, 'utf-8'));
  } catch (err) {
    await onStatus(
      `Failed to parse pipeline: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  // Ensure project repo exists
  const projectDir = path.join(DATA_DIR, 'projects', projectName);
  if (!fs.existsSync(path.join(projectDir, '.git'))) {
    fs.mkdirSync(projectDir, { recursive: true });
    execSync(
      'git init && git config user.name "nanoclaw" && git config user.email "agent@nanoclaw.local"',
      { cwd: projectDir, stdio: 'ignore' },
    );
  }

  await onStatus(
    `Starting pipeline "${pipeline.name}" for project "${projectName}" (${pipeline.stages.length} stages)`,
  );

  for (const stage of pipeline.stages) {
    await onStatus(`Stage: ${stage.name} (${stage.agents.length} agent${stage.agents.length > 1 ? 's' : ''}${stage.parallel ? ', parallel' : ''})`);

    if (stage.parallel && stage.agents.length > 1) {
      // Parallel execution: each agent gets a git worktree
      const worktrees: Array<{
        agent: PipelineAgent;
        branch: string;
        wtPath: string;
      }> = [];

      for (const agent of stage.agents) {
        const branch = `pipeline/${stage.name}/${agent.group_suffix}`;
        const wtPath = path.join(projectDir, `.worktrees`, agent.group_suffix);

        try {
          // Clean up stale worktree if exists
          try {
            execSync(`git worktree remove "${wtPath}" --force`, {
              cwd: projectDir,
              stdio: 'ignore',
            });
          } catch { /* ignore */ }
          try {
            execSync(`git branch -D "${branch}"`, {
              cwd: projectDir,
              stdio: 'ignore',
            });
          } catch { /* ignore */ }

          // Create fresh worktree from current HEAD
          fs.mkdirSync(path.dirname(wtPath), { recursive: true });
          execSync(`git worktree add "${wtPath}" -b "${branch}"`, {
            cwd: projectDir,
            stdio: 'ignore',
          });
          worktrees.push({ agent, branch, wtPath });
        } catch (err) {
          logger.warn(
            { agent: agent.group_suffix, err },
            'Failed to create git worktree, falling back to main repo',
          );
          worktrees.push({ agent, branch: '', wtPath: projectDir });
        }
      }

      // Run all agents in parallel
      const results = await Promise.allSettled(
        worktrees.map(({ agent, wtPath }) =>
          runPipelineAgent(agent, projectDir, wtPath, params, chatJid),
        ),
      );

      // Merge worktrees back
      for (let i = 0; i < worktrees.length; i++) {
        const { agent, branch, wtPath } = worktrees[i];
        const result = results[i];

        const status =
          result.status === 'fulfilled' ? result.value.status : 'error';
        logger.info(
          { agent: agent.group_suffix, status },
          'Pipeline agent completed',
        );

        if (branch && wtPath !== projectDir) {
          try {
            // Add and commit any uncommitted changes in worktree
            execSync('git add -A && git diff --cached --quiet || git commit -m "Pipeline auto-commit"', {
              cwd: wtPath,
              stdio: 'ignore',
            });
            // Merge branch back to main
            execSync(`git merge "${branch}" --no-edit -m "Merge ${stage.name}/${agent.group_suffix}"`, {
              cwd: projectDir,
              stdio: 'ignore',
            });
          } catch (err) {
            logger.warn(
              { agent: agent.group_suffix, err },
              'Failed to merge worktree (may need manual resolution)',
            );
          }
          // Cleanup worktree
          try {
            execSync(`git worktree remove "${wtPath}" --force`, {
              cwd: projectDir,
              stdio: 'ignore',
            });
            execSync(`git branch -D "${branch}"`, {
              cwd: projectDir,
              stdio: 'ignore',
            });
          } catch { /* ignore cleanup errors */ }
        }
      }
    } else {
      // Sequential execution
      for (const agent of stage.agents) {
        const result = await runPipelineAgent(
          agent,
          projectDir,
          projectDir,
          params,
          chatJid,
        );
        logger.info(
          { agent: agent.group_suffix, status: result.status },
          'Pipeline agent completed',
        );

        if (result.status === 'error') {
          await onStatus(
            `Agent ${agent.group_suffix} failed in stage ${stage.name}. Continuing...`,
          );
        }
      }

      // Auto-commit any uncommitted changes after sequential stage
      try {
        execSync(
          `git add -A && git diff --cached --quiet || git commit -m "Stage: ${stage.name} completed"`,
          { cwd: projectDir, stdio: 'ignore' },
        );
      } catch { /* ignore */ }
    }

    await onStatus(`Stage "${stage.name}" completed`);
  }

  await onStatus(
    `Pipeline "${pipeline.name}" completed for project "${projectName}"`,
  );
}
