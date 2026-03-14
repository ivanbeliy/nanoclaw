/**
 * Stdio MCP Server for NanoClaw
 * Standalone process that agent teams subagents can inherit.
 * Reads context from environment variables, writes IPC files for the host.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';
import { parse as parseYaml } from 'yaml';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');

// Context from environment variables (set by the agent runner)
const chatJid = process.env.NANOCLAW_CHAT_JID!;
const groupFolder = process.env.NANOCLAW_GROUP_FOLDER!;
const isMain = process.env.NANOCLAW_IS_MAIN === '1';

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

const server = new McpServer({
  name: 'nanoclaw',
  version: '1.0.0',
});

server.tool(
  'send_message',
  "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times.",
  {
    text: z.string().describe('The message text to send'),
    sender: z.string().optional().describe('Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.'),
  },
  async (args) => {
    const data: Record<string, string | undefined> = {
      type: 'message',
      chatJid,
      text: args.text,
      sender: args.sender || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
  },
);

server.tool(
  'schedule_task',
  `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools. Returns the task ID for future reference. To modify an existing task, use update_task instead.

CONTEXT MODE - Choose based on task type:
\u2022 "group": Task runs in the group's conversation context, with access to chat history. Use for tasks that need context about ongoing discussions, user preferences, or recent interactions.
\u2022 "isolated": Task runs in a fresh session with no conversation history. Use for independent tasks that don't need prior context. When using isolated mode, include all necessary context in the prompt itself.

If unsure which mode to use, you can ask the user. Examples:
- "Remind me about our discussion" \u2192 group (needs conversation context)
- "Check the weather every morning" \u2192 isolated (self-contained task)
- "Follow up on my request" \u2192 group (needs to know what was requested)
- "Generate a daily report" \u2192 isolated (just needs instructions in prompt)

MESSAGING BEHAVIOR - The task agent's output is sent to the user or group. It can also use send_message for immediate delivery, or wrap output in <internal> tags to suppress it. Include guidance in the prompt about whether the agent should:
\u2022 Always send a message (e.g., reminders, daily briefings)
\u2022 Only send a message when there's something to report (e.g., "notify me if...")
\u2022 Never send a message (background maintenance tasks)

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
\u2022 cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am LOCAL time)
\u2022 interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
\u2022 once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.`,
  {
    prompt: z.string().describe('What the agent should do when the task runs. For isolated mode, include all necessary context here.'),
    schedule_type: z.enum(['cron', 'interval', 'once']).describe('cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time'),
    schedule_value: z.string().describe('cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)'),
    context_mode: z.enum(['group', 'isolated']).default('group').describe('group=runs with chat history and memory, isolated=fresh session (include context in prompt)'),
    target_group_jid: z.string().optional().describe('(Main group only) JID of the group to schedule the task for. Defaults to the current group.'),
  },
  async (args) => {
    // Validate schedule_value before writing IPC
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'once') {
      if (/[Zz]$/.test(args.schedule_value) || /[+-]\d{2}:\d{2}$/.test(args.schedule_value)) {
        return {
          content: [{ type: 'text' as const, text: `Timestamp must be local time without timezone suffix. Got "${args.schedule_value}" — use format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [{ type: 'text' as const, text: `Invalid timestamp: "${args.schedule_value}". Use local time format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
    }

    // Non-main groups can only schedule for themselves
    const targetJid = isMain && args.target_group_jid ? args.target_group_jid : chatJid;

    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const data = {
      type: 'schedule_task',
      taskId,
      prompt: args.prompt,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'group',
      targetJid,
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Task ${taskId} scheduled: ${args.schedule_type} - ${args.schedule_value}` }],
    };
  },
);

server.tool(
  'list_tasks',
  "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
  {},
  async () => {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

    try {
      if (!fs.existsSync(tasksFile)) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

      const tasks = isMain
        ? allTasks
        : allTasks.filter((t: { groupFolder: string }) => t.groupFolder === groupFolder);

      if (tasks.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const formatted = tasks
        .map(
          (t: { id: string; prompt: string; schedule_type: string; schedule_value: string; status: string; next_run: string }) =>
            `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
        )
        .join('\n');

      return { content: [{ type: 'text' as const, text: `Scheduled tasks:\n${formatted}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  },
);

server.tool(
  'pause_task',
  'Pause a scheduled task. It will not run until resumed.',
  { task_id: z.string().describe('The task ID to pause') },
  async (args) => {
    const data = {
      type: 'pause_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} pause requested.` }] };
  },
);

server.tool(
  'resume_task',
  'Resume a paused task.',
  { task_id: z.string().describe('The task ID to resume') },
  async (args) => {
    const data = {
      type: 'resume_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} resume requested.` }] };
  },
);

server.tool(
  'cancel_task',
  'Cancel and delete a scheduled task.',
  { task_id: z.string().describe('The task ID to cancel') },
  async (args) => {
    const data = {
      type: 'cancel_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} cancellation requested.` }] };
  },
);

server.tool(
  'update_task',
  'Update an existing scheduled task. Only provided fields are changed; omitted fields stay the same.',
  {
    task_id: z.string().describe('The task ID to update'),
    prompt: z.string().optional().describe('New prompt for the task'),
    schedule_type: z.enum(['cron', 'interval', 'once']).optional().describe('New schedule type'),
    schedule_value: z.string().optional().describe('New schedule value (see schedule_task for format)'),
  },
  async (args) => {
    // Validate schedule_value if provided
    if (args.schedule_type === 'cron' || (!args.schedule_type && args.schedule_value)) {
      if (args.schedule_value) {
        try {
          CronExpressionParser.parse(args.schedule_value);
        } catch {
          return {
            content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}".` }],
            isError: true,
          };
        }
      }
    }
    if (args.schedule_type === 'interval' && args.schedule_value) {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}".` }],
          isError: true,
        };
      }
    }

    const data: Record<string, string | undefined> = {
      type: 'update_task',
      taskId: args.task_id,
      groupFolder,
      isMain: String(isMain),
      timestamp: new Date().toISOString(),
    };
    if (args.prompt !== undefined) data.prompt = args.prompt;
    if (args.schedule_type !== undefined) data.schedule_type = args.schedule_type;
    if (args.schedule_value !== undefined) data.schedule_value = args.schedule_value;

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} update requested.` }] };
  },
);

server.tool(
  'register_group',
  `Register a new chat/group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name must be channel-prefixed: "{channel}_{group-name}" (e.g., "whatsapp_family-chat", "telegram_dev-team", "discord_general"). Use lowercase with hyphens for the group name part.

To assign a project to the group, pass the project name in container_config_project. The agent will get /workspace/project mounted with the project's git repo (RW). Initialize the project first with init_project.`,
  {
    jid: z.string().describe('The chat JID (e.g., "120363336345536173@g.us", "tg:-1001234567890", "dc:1234567890123456")'),
    name: z.string().describe('Display name for the group'),
    folder: z.string().describe('Channel-prefixed folder name (e.g., "whatsapp_family-chat", "telegram_dev-team")'),
    trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
    container_config_project: z.string().optional().describe('Project name to mount as /workspace/project (must be initialized with init_project first)'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can register new groups.' }],
        isError: true,
      };
    }

    const data: Record<string, unknown> = {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      timestamp: new Date().toISOString(),
    };

    if (args.container_config_project) {
      data.containerConfig = { project: args.container_config_project };
    }

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Group "${args.name}" registered${args.container_config_project ? ` with project "${args.container_config_project}"` : ''}. It will start receiving messages immediately.` }],
    };
  },
);

server.tool(
  'run_pipeline',
  `Execute a multi-stage agent pipeline.
Reads pipeline definition from /workspace/group/pipelines/{name}.yaml (group-local) or /workspace/system/pipelines/{name}.yaml (system-wide). Group-local pipelines take priority.

Main group: can specify any project. Non-main groups: automatically use the group's assigned project.

Pipeline YAML format:
\`\`\`yaml
name: my-pipeline
description: What this pipeline does
stages:
  - name: research
    parallel: true    # agents in this stage run concurrently
    agents:
      - role: researcher    # loads role from roles/researcher.md (group-local or system)
        prompt: "Research {topic}"  # {params} are interpolated
        group_suffix: research-1    # unique suffix for this agent
      - role: researcher
        prompt: "Research {topic} from technical angle"
        group_suffix: research-2
  - name: synthesize        # sequential stage (waits for previous)
    agents:
      - role: cto
        prompt: "Read research results and create plan"
        group_suffix: synthesis
\`\`\`

Parallel agents use git worktrees — each gets an isolated branch, merged back after completion.
Status updates are sent to the chat as the pipeline progresses.`,
  {
    pipeline: z.string().describe('Pipeline name (filename without .yaml)'),
    project: z.string().optional().describe('Project name (main group only — non-main uses assigned project)'),
    params: z.record(z.string(), z.string()).optional().describe('Key-value params to interpolate in prompts (e.g., {topic} in prompt)'),
  },
  async (args) => {
    // Validate pipeline name
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(args.pipeline)) {
      return {
        content: [{ type: 'text' as const, text: 'Invalid pipeline name. Use alphanumeric characters, hyphens, and underscores only.' }],
        isError: true,
      };
    }

    const data: Record<string, unknown> = {
      type: 'run_pipeline',
      pipeline: args.pipeline,
      params: args.params || {},
      chatJid,
      timestamp: new Date().toISOString(),
    };

    // Main sends project explicitly; non-main omits it (host resolves from config)
    if (isMain) {
      if (!args.project) {
        return {
          content: [{ type: 'text' as const, text: 'Main group must specify a project name.' }],
          isError: true,
        };
      }
      data.project = args.project;
    }

    writeIpcFile(TASKS_DIR, data);

    const projectLabel = isMain ? args.project : '(assigned project)';
    return {
      content: [{ type: 'text' as const, text: `Pipeline "${args.pipeline}" started for project "${projectLabel}". Status updates will be sent to this chat.` }],
    };
  },
);

server.tool(
  'write_pipeline',
  `Write a pipeline YAML definition to your group's local pipelines directory.
The pipeline will be available to run_pipeline for this group. Group-local pipelines take priority over system pipelines.

Pipeline YAML must contain at minimum: name, stages (with name, agents).`,
  {
    name: z.string().describe('Pipeline name (alphanumeric, hyphens, underscores)'),
    content: z.string().describe('Pipeline YAML content'),
  },
  async (args) => {
    // Validate name
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(args.name)) {
      return {
        content: [{ type: 'text' as const, text: 'Invalid pipeline name. Use alphanumeric characters, hyphens, and underscores only (1-64 chars).' }],
        isError: true,
      };
    }

    // Validate YAML structure
    let parsed: Record<string, unknown>;
    try {
      parsed = parseYaml(args.content);
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Invalid YAML: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }

    if (!parsed || typeof parsed !== 'object' || !parsed.name || !parsed.stages) {
      return {
        content: [{ type: 'text' as const, text: 'Pipeline YAML must contain "name" and "stages" fields.' }],
        isError: true,
      };
    }

    const pipelinesDir = '/workspace/group/pipelines';
    fs.mkdirSync(pipelinesDir, { recursive: true });
    const filePath = path.join(pipelinesDir, `${args.name}.yaml`);
    fs.writeFileSync(filePath, args.content);

    return {
      content: [{ type: 'text' as const, text: `Pipeline "${args.name}" written to ${filePath}` }],
    };
  },
);

server.tool(
  'write_role',
  `Write a role definition to your group's local roles directory.
The role will be available for use in pipeline agents. Group-local roles take priority over system roles.`,
  {
    name: z.string().describe('Role name (alphanumeric, hyphens, underscores)'),
    content: z.string().describe('Role definition content (markdown)'),
  },
  async (args) => {
    // Validate name
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(args.name)) {
      return {
        content: [{ type: 'text' as const, text: 'Invalid role name. Use alphanumeric characters, hyphens, and underscores only (1-64 chars).' }],
        isError: true,
      };
    }

    const rolesDir = '/workspace/group/roles';
    fs.mkdirSync(rolesDir, { recursive: true });
    const filePath = path.join(rolesDir, `${args.name}.md`);
    fs.writeFileSync(filePath, args.content);

    return {
      content: [{ type: 'text' as const, text: `Role "${args.name}" written to ${filePath}` }],
    };
  },
);

server.tool(
  'write_system_file',
  `Write a file to the system layer (data/system/). Main group only.
Use this to manage system-wide skills, roles, pipelines, and bootstrap scripts.

Paths are relative to the system root. Examples:
- "skills/research.md" — system-wide skill
- "roles/ceo.md" — role definition
- "pipelines/launch.yaml" — pipeline definition
- "bootstrap.sh" — bootstrap script (runs on every container start)
- "CLAUDE.md" — system-wide context loaded by all agents`,
  {
    file_path: z.string().describe('Path relative to system root (e.g., "skills/research.md")'),
    content: z.string().describe('File content to write'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can write system files.' }],
        isError: true,
      };
    }

    // Basic path validation
    if (args.file_path.includes('..') || args.file_path.startsWith('/')) {
      return {
        content: [{ type: 'text' as const, text: 'Invalid path: must be relative and cannot contain ".."' }],
        isError: true,
      };
    }

    writeIpcFile(TASKS_DIR, {
      type: 'write_system_file',
      filePath: args.file_path,
      content: args.content,
      timestamp: new Date().toISOString(),
    });

    return {
      content: [{ type: 'text' as const, text: `System file written: ${args.file_path}` }],
    };
  },
);

server.tool(
  'delete_system_file',
  'Delete a file from the system layer. Main group only.',
  {
    file_path: z.string().describe('Path relative to system root (e.g., "skills/old-skill.md")'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can delete system files.' }],
        isError: true,
      };
    }

    if (args.file_path.includes('..') || args.file_path.startsWith('/')) {
      return {
        content: [{ type: 'text' as const, text: 'Invalid path.' }],
        isError: true,
      };
    }

    writeIpcFile(TASKS_DIR, {
      type: 'delete_system_file',
      filePath: args.file_path,
      timestamp: new Date().toISOString(),
    });

    return {
      content: [{ type: 'text' as const, text: `System file deletion requested: ${args.file_path}` }],
    };
  },
);

server.tool(
  'init_project',
  `Initialize a new project git repository. Main group only.
Creates a git repo in data/projects/{name}/ that can be mounted into project agent containers.
After initializing, register a group with containerConfig.project set to this name.`,
  {
    project_name: z.string().describe('Project name (alphanumeric, hyphens, underscores)'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can initialize projects.' }],
        isError: true,
      };
    }

    writeIpcFile(TASKS_DIR, {
      type: 'init_project',
      projectName: args.project_name,
      timestamp: new Date().toISOString(),
    });

    return {
      content: [{ type: 'text' as const, text: `Project "${args.project_name}" initialization requested. Use register_group with containerConfig.project="${args.project_name}" to assign agents.` }],
    };
  },
);

// --- GDrive tools (host-side proxy via IPC) ---

const RESPONSES_DIR = path.join(IPC_DIR, 'responses');

/**
 * Write an IPC task and poll for the host's response.
 */
async function ipcRequestResponse(
  taskData: Record<string, unknown>,
  timeoutMs = 30000,
): Promise<{ result?: unknown; error?: string }> {
  const responseId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  writeIpcFile(TASKS_DIR, { ...taskData, responseId });

  const responseFile = path.join(RESPONSES_DIR, `${responseId}.json`);
  const deadline = Date.now() + timeoutMs;
  const pollInterval = 500;

  while (Date.now() < deadline) {
    if (fs.existsSync(responseFile)) {
      const data = JSON.parse(fs.readFileSync(responseFile, 'utf-8'));
      // Clean up response file
      try {
        fs.unlinkSync(responseFile);
      } catch { /* ignore */ }
      return data;
    }
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  return { error: 'Request timed out waiting for host response' };
}

server.tool(
  'gdrive_list',
  `List files and folders on Google Drive. Available to all groups.
Returns a JSON list of files with path, size, modification time, and whether it's a directory.`,
  {
    path: z.string().default('').describe('Remote path on Google Drive (e.g., "Documents/reports" or "" for root)'),
  },
  async (args) => {
    const response = await ipcRequestResponse({
      type: 'gdrive_list',
      remotePath: args.path,
      timestamp: new Date().toISOString(),
    });

    if (response.error) {
      return {
        content: [{ type: 'text' as const, text: `GDrive list error: ${response.error}` }],
        isError: true,
      };
    }

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(response.result, null, 2) }],
    };
  },
);

server.tool(
  'gdrive_download',
  `Download a file from Google Drive to the group's local directory.
The file will be available at /workspace/group/{local_file}.`,
  {
    remote_path: z.string().describe('Path on Google Drive (e.g., "Documents/report.pdf")'),
    local_file: z.string().describe('Local filename relative to /workspace/group/ (e.g., "downloads/report.pdf")'),
  },
  async (args) => {
    // Basic validation
    if (args.local_file.includes('..') || args.local_file.startsWith('/')) {
      return {
        content: [{ type: 'text' as const, text: 'Invalid local_file: must be relative and cannot contain ".."' }],
        isError: true,
      };
    }

    const response = await ipcRequestResponse({
      type: 'gdrive_download',
      remotePath: args.remote_path,
      localFile: args.local_file,
      timestamp: new Date().toISOString(),
    });

    if (response.error) {
      return {
        content: [{ type: 'text' as const, text: `GDrive download error: ${response.error}` }],
        isError: true,
      };
    }

    return {
      content: [{ type: 'text' as const, text: `Downloaded to /workspace/group/${args.local_file}` }],
    };
  },
);

server.tool(
  'gdrive_upload',
  `Upload a file from the group's local directory to Google Drive.
The file must exist at /workspace/group/{local_file}.`,
  {
    local_file: z.string().describe('Local filename relative to /workspace/group/ (e.g., "output/report.pdf")'),
    remote_path: z.string().describe('Destination path on Google Drive (e.g., "Reports/weekly-report.pdf")'),
  },
  async (args) => {
    if (args.local_file.includes('..') || args.local_file.startsWith('/')) {
      return {
        content: [{ type: 'text' as const, text: 'Invalid local_file: must be relative and cannot contain ".."' }],
        isError: true,
      };
    }

    // Check file exists locally
    const localPath = path.join('/workspace/group', args.local_file);
    if (!fs.existsSync(localPath)) {
      return {
        content: [{ type: 'text' as const, text: `File not found: /workspace/group/${args.local_file}` }],
        isError: true,
      };
    }

    const response = await ipcRequestResponse({
      type: 'gdrive_upload',
      localFile: args.local_file,
      remotePath: args.remote_path,
      timestamp: new Date().toISOString(),
    });

    if (response.error) {
      return {
        content: [{ type: 'text' as const, text: `GDrive upload error: ${response.error}` }],
        isError: true,
      };
    }

    return {
      content: [{ type: 'text' as const, text: `Uploaded to gdrive:${args.remote_path}` }],
    };
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
