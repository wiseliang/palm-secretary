import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type Project = {
  id: string;
  name: string;
  directory: string;
  createdAt: string;
  updatedAt: string;
  model?: string;
  reasoningEffort?: string;
};

export type ProjectThread = {
  threadId: string;
  projectId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
};

export type ProjectTask = {
  taskId: string;
  turnId: string;
  threadId: string;
  projectId: string;
  title: string;
  status: 'running' | 'completed' | 'failed' | 'interrupted';
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  attachments: string[];
  outputPaths: string[];
  errorMessage?: string;
  outputBaseline?: Record<string, string>;
};

type StoreState = { version: 4; projects: Project[]; threads: ProjectThread[]; tasks: ProjectTask[] };

const PROJECT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export class ProjectStore {
  private readonly stateDir: string;
  private readonly stateFile: string;
  private state: StoreState = { version: 4, projects: [], threads: [], tasks: [] };
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly workspace: string) {
    this.stateDir = path.join(workspace, '.palm');
    this.stateFile = path.join(this.stateDir, 'state.json');
  }

  async initialize(): Promise<void> {
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    try {
      const parsed = JSON.parse(await readFile(this.stateFile, 'utf8')) as StoreState | (Omit<StoreState, 'version'> & { version: 3 }) | (Omit<StoreState, 'version' | 'tasks'> & { version: 2 });
      if (![2, 3, 4].includes(parsed.version) || !Array.isArray(parsed.projects) || !Array.isArray(parsed.threads)) throw new Error('版本不兼容');
      const parsedTasks = parsed.version === 2 ? [] : parsed.tasks;
      const tasks: ProjectTask[] = Array.isArray(parsedTasks)
        ? parsedTasks.map((task: ProjectTask) => ({ ...task, attachments: Array.isArray(task.attachments) ? task.attachments : [], outputPaths: Array.isArray(task.outputPaths) ? task.outputPaths : [] }))
        : [];
      this.state = { version: 4, projects: parsed.projects, threads: parsed.threads, tasks };
      if (parsed.version !== 4) await this.persist();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        await writeFile(`${this.stateFile}.invalid-${Date.now()}`, await readFile(this.stateFile), { mode: 0o600 }).catch(() => undefined);
      }
      const now = new Date().toISOString();
      this.state = { version: 4, projects: [{ id: 'default', name: '默认项目', directory: 'default', createdAt: now, updatedAt: now }], threads: [], tasks: [] };
      await this.persist();
    }
    if (!this.state.projects.some((project) => project.id === 'default')) {
      const now = new Date().toISOString();
      this.state.projects.unshift({ id: 'default', name: '默认项目', directory: 'default', createdAt: now, updatedAt: now });
      await this.persist();
    }
    for (const project of this.state.projects) await this.ensureProjectDirectories(project);
    await this.migrateLegacyFiles();
  }

  listProjects(): Project[] {
    return [...this.state.projects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  getProject(id: string): Project {
    if (!PROJECT_ID.test(id)) throw new Error('项目编号无效');
    const project = this.state.projects.find((item) => item.id === id);
    if (!project) throw new Error('项目不存在');
    return project;
  }

  projectRoot(id: string): string {
    const project = this.getProject(id);
    const projectsRoot = path.join(this.workspace, 'projects');
    const resolved = path.resolve(projectsRoot, project.directory);
    if (!resolved.startsWith(`${projectsRoot}${path.sep}`)) throw new Error('项目路径无效');
    return resolved;
  }

  inbox(id: string): string { return path.join(this.projectRoot(id), 'inbox'); }
  outbox(id: string): string { return path.join(this.projectRoot(id), 'outbox'); }

  async createProject(name: string): Promise<Project> {
    const cleanName = name.trim().replace(/[\u0000-\u001f]/g, '').slice(0, 50);
    if (!cleanName) throw new Error('项目名称不能为空');
    const now = new Date().toISOString();
    const id = `p-${randomUUID()}`;
    const project = { id, name: cleanName, directory: id, createdAt: now, updatedAt: now };
    this.state.projects.push(project);
    await this.ensureProjectDirectories(project);
    await this.persist();
    return project;
  }

  async renameProject(id: string, name: string): Promise<Project> {
    const project = this.getProject(id);
    const cleanName = name.trim().replace(/[\u0000-\u001f]/g, '').slice(0, 50);
    if (!cleanName) throw new Error('项目名称不能为空');
    project.name = cleanName;
    project.updatedAt = new Date().toISOString();
    await this.persist();
    return project;
  }

  async setProjectModel(id: string, model: string, reasoningEffort?: string): Promise<Project> {
    const project = this.getProject(id);
    project.model = model;
    project.reasoningEffort = reasoningEffort;
    project.updatedAt = new Date().toISOString();
    await this.persist();
    return project;
  }

  listThreads(projectId: string): ProjectThread[] {
    this.getProject(projectId);
    return this.state.threads.filter((thread) => thread.projectId === projectId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  listTasks(projectId: string): ProjectTask[] {
    this.getProject(projectId);
    return this.state.tasks.filter((task) => task.projectId === projectId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 200);
  }

  async outputBaseline(projectId: string): Promise<Record<string, string>> {
    return this.snapshotOutbox(projectId);
  }

  async rememberTask(turnId: string, threadId: string, projectId: string, title: string, attachments: string[] = [], outputBaseline?: Record<string, string>): Promise<ProjectTask> {
    this.assertThreadProject(threadId, projectId);
    const now = new Date().toISOString();
    let task = this.state.tasks.find((item) => item.turnId === turnId);
    if (!task) {
      task = {
        taskId: turnId, turnId, threadId, projectId,
        title: title.trim().slice(0, 120) || '新任务', status: 'running', startedAt: now, updatedAt: now,
        attachments: [...attachments], outputPaths: [], outputBaseline: outputBaseline ?? await this.snapshotOutbox(projectId),
      };
      this.state.tasks.push(task);
    }
    await this.persist();
    return task;
  }

  async finishTask(threadId: string, turnId: string | undefined, status: ProjectTask['status'], errorMessage?: string): Promise<void> {
    const task = turnId
      ? this.state.tasks.find((item) => item.threadId === threadId && item.turnId === turnId)
      : [...this.state.tasks].reverse().find((item) => item.threadId === threadId && item.status === 'running');
    if (!task) return;
    const now = new Date().toISOString();
    task.status = status;
    task.updatedAt = now;
    task.completedAt = now;
    task.errorMessage = errorMessage?.trim().slice(0, 500) || undefined;
    const currentOutputs = await this.snapshotOutbox(task.projectId);
    task.outputPaths = Object.entries(currentOutputs)
      .filter(([name, signature]) => task.outputBaseline?.[name] !== signature)
      .map(([name]) => `outbox/${name}`);
    delete task.outputBaseline;
    await this.persist();
  }

  assertThreadProject(threadId: string, projectId: string): void {
    const thread = this.state.threads.find((item) => item.threadId === threadId);
    if (!thread || thread.projectId !== projectId) throw new Error('该对话不属于当前项目');
  }

  async rememberThread(threadId: string, projectId: string, title: string): Promise<ProjectThread> {
    const project = this.getProject(projectId);
    const now = new Date().toISOString();
    let thread = this.state.threads.find((item) => item.threadId === threadId);
    if (thread && thread.projectId !== projectId) throw new Error('该对话已属于另一个项目');
    if (!thread) {
      thread = { threadId, projectId, title: title.trim().slice(0, 80) || '新对话', createdAt: now, updatedAt: now };
      this.state.threads.push(thread);
    } else {
      thread.updatedAt = now;
      if (thread.title === '新对话' && title.trim()) thread.title = title.trim().slice(0, 80);
    }
    project.updatedAt = now;
    await this.persist();
    return thread;
  }

  safeStoredPath(projectId: string, relativePath: string): string {
    const root = this.projectRoot(projectId);
    const inbox = path.join(root, 'inbox');
    const outbox = path.join(root, 'outbox');
    const resolved = path.resolve(root, relativePath);
    if (resolved !== inbox && !resolved.startsWith(`${inbox}${path.sep}`) && resolved !== outbox && !resolved.startsWith(`${outbox}${path.sep}`)) {
      throw new Error('文件路径不在当前项目的允许范围内');
    }
    return resolved;
  }

  private async ensureProjectDirectories(project: Project): Promise<void> {
    const root = this.projectRoot(project.id);
    await mkdir(path.join(root, 'inbox'), { recursive: true, mode: 0o700 });
    await mkdir(path.join(root, 'outbox'), { recursive: true, mode: 0o700 });
    const agents = path.join(root, 'AGENTS.md');
    try { await access(agents); }
    catch {
      await writeFile(agents, `# ${project.name}\n\n这是掌心助理的独立项目工作区。\n\n- 只处理当前项目中的文件和对话，不主动读取 \`../\` 下的其他项目。\n- 用户上传的文件在 \`inbox/\`。\n- 生成的可下载成果保存到 \`outbox/\`。\n- 修改、构建和诊断任务可直接执行，无需重复请求常规本地权限。\n`, { mode: 0o600 });
    }
  }

  private async migrateLegacyFiles(): Promise<void> {
    for (const folder of ['inbox', 'outbox'] as const) {
      const legacy = path.join(this.workspace, folder);
      let entries;
      try { entries = await readdir(legacy, { withFileTypes: true }); }
      catch { continue; }
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const source = path.join(legacy, entry.name);
        let destination = path.join(this.projectRoot('default'), folder, entry.name);
        try { await access(destination); destination = path.join(this.projectRoot('default'), folder, `${Date.now()}-${entry.name}`); }
        catch { /* destination is free */ }
        await rename(source, destination);
      }
    }
  }

  private async snapshotOutbox(projectId: string): Promise<Record<string, string>> {
    const root = this.outbox(projectId);
    const snapshot: Record<string, string> = {};
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const details = await stat(path.join(root, entry.name));
      snapshot[entry.name] = `${details.size}:${details.mtimeMs}`;
    }
    return snapshot;
  }

  private async persist(): Promise<void> {
    const data = `${JSON.stringify(this.state, null, 2)}\n`;
    this.writeQueue = this.writeQueue.then(async () => {
      const temporary = `${this.stateFile}.${process.pid}.tmp`;
      await writeFile(temporary, data, { mode: 0o600 });
      await rename(temporary, this.stateFile);
    });
    await this.writeQueue;
  }
}
