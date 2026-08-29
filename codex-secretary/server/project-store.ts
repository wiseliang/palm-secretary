import { randomUUID } from 'node:crypto';
import { access, cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type Project = {
  id: string;
  name: string;
  directory: string;
  createdAt: string;
  updatedAt: string;
  model?: string;
  reasoningEffort?: string;
  archivedAt?: string;
  workdir?: string;
};

export type ProjectThread = {
  threadId: string;
  projectId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
  favorite?: boolean;
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
  clientRequestId?: string;
};

type StoreState = { version: 7; projects: Project[]; threads: ProjectThread[]; tasks: ProjectTask[] };

const PROJECT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export class ProjectStore {
  private readonly stateDir: string;
  private readonly stateFile: string;
  private state: StoreState = { version: 7, projects: [], threads: [], tasks: [] };
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly workspace: string) {
    this.stateDir = path.join(workspace, '.palm');
    this.stateFile = path.join(this.stateDir, 'state.json');
  }

  async initialize(): Promise<void> {
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    try {
      const parsed = JSON.parse(await readFile(this.stateFile, 'utf8')) as StoreState | (Omit<StoreState, 'version'> & { version: 3 | 4 | 5 | 6 }) | (Omit<StoreState, 'version' | 'tasks'> & { version: 2 });
      if (![2, 3, 4, 5, 6, 7].includes(parsed.version) || !Array.isArray(parsed.projects) || !Array.isArray(parsed.threads)) throw new Error('版本不兼容');
      const parsedTasks = parsed.version === 2 ? [] : parsed.tasks;
      const tasks: ProjectTask[] = Array.isArray(parsedTasks)
        ? parsedTasks.map((task: ProjectTask) => ({ ...task, attachments: Array.isArray(task.attachments) ? task.attachments : [], outputPaths: Array.isArray(task.outputPaths) ? task.outputPaths : [] }))
        : [];
      this.state = { version: 7, projects: parsed.projects, threads: parsed.threads, tasks };
      if (parsed.version !== 7) await this.persist();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        await writeFile(`${this.stateFile}.invalid-${Date.now()}`, await readFile(this.stateFile), { mode: 0o600 }).catch(() => undefined);
      }
      const now = new Date().toISOString();
      this.state = { version: 7, projects: [{ id: 'default', name: '默认项目', directory: 'default', createdAt: now, updatedAt: now }], threads: [], tasks: [] };
      await this.persist();
    }
    if (!this.state.projects.some((project) => project.id === 'default')) {
      const now = new Date().toISOString();
      this.state.projects.unshift({ id: 'default', name: '默认项目', directory: 'default', createdAt: now, updatedAt: now });
      await this.persist();
    }
    for (const project of this.state.projects) await this.ensureProjectDirectories(project);
    let migratedWorkdirs = false;
    for (const project of this.state.projects) {
      if (project.workdir) continue;
      if ((await stat(path.join(this.projectRoot(project.id), 'repository', '.git')).catch(() => null))?.isDirectory()) {
        project.workdir = 'repository'; await mkdir(this.inbox(project.id), { recursive: true, mode: 0o700 }); await mkdir(this.outbox(project.id), { recursive: true, mode: 0o700 }); migratedWorkdirs = true;
      }
    }
    if (migratedWorkdirs) await this.persist();
    const interruptedAt = new Date().toISOString();
    let recovered = false;
    for (const task of this.state.tasks) {
      if (task.status !== 'running') continue;
      task.status = 'interrupted'; task.updatedAt = interruptedAt; task.completedAt = interruptedAt;
      task.errorMessage = '服务重启时任务仍在运行，请确认结果后再重新执行'; delete task.outputBaseline; recovered = true;
    }
    if (recovered) await this.persist();
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

  projectWorkdir(id: string): string {
    const project = this.getProject(id);
    const root = this.projectRoot(id);
    const resolved = path.resolve(root, project.workdir || '.');
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error('项目工作目录无效');
    return resolved;
  }

  inbox(id: string): string { return path.join(this.projectWorkdir(id), 'inbox'); }
  outbox(id: string): string { return path.join(this.projectWorkdir(id), 'outbox'); }

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

  async setProjectWorkdir(id: string, workdir?: string): Promise<Project> {
    const project = this.getProject(id);
    const normalized = workdir?.trim().replaceAll('\\', '/');
    if (normalized && (path.isAbsolute(normalized) || normalized.split('/').includes('..'))) throw new Error('项目工作目录无效');
    project.workdir = normalized || undefined;
    project.updatedAt = new Date().toISOString();
    await mkdir(this.inbox(id), { recursive: true, mode: 0o700 });
    await mkdir(this.outbox(id), { recursive: true, mode: 0o700 });
    await this.persist();
    return project;
  }

  hasRunningTask(projectId: string): boolean {
    return this.state.tasks.some((task) => task.projectId === projectId && task.status === 'running');
  }

  async deleteProject(id: string): Promise<void> {
    if (id === 'default') throw new Error('默认项目不能删除');
    if (this.hasRunningTask(id)) throw new Error('项目仍有运行中的任务');
    const root = this.projectRoot(id);
    this.state.projects = this.state.projects.filter((project) => project.id !== id);
    this.state.threads = this.state.threads.filter((thread) => thread.projectId !== id);
    this.state.tasks = this.state.tasks.filter((task) => task.projectId !== id);
    await this.persist();
    await rm(root, { recursive: true, force: true });
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

  async archiveProject(id: string, archived: boolean): Promise<Project> {
    if (id === 'default' && archived) throw new Error('默认项目不能归档');
    const project = this.getProject(id);
    project.archivedAt = archived ? new Date().toISOString() : undefined;
    project.updatedAt = new Date().toISOString();
    await this.persist(); return project;
  }

  async duplicateProject(id: string, name: string): Promise<Project> {
    const source = this.getProject(id);
    const duplicate = await this.createProject(name);
    await cp(this.projectRoot(source.id), this.projectRoot(duplicate.id), { recursive: true, force: false, errorOnExist: false, filter: (entry) => !entry.includes(`${path.sep}.git${path.sep}`) && !entry.endsWith(`${path.sep}.git`) });
    duplicate.model = source.model; duplicate.reasoningEffort = source.reasoningEffort; duplicate.workdir = source.workdir;
    duplicate.updatedAt = new Date().toISOString(); await this.persist(); return duplicate;
  }

  async setProjectModel(id: string, model: string, reasoningEffort?: string): Promise<Project> {
    const project = this.getProject(id);
    project.model = model;
    project.reasoningEffort = reasoningEffort;
    project.updatedAt = new Date().toISOString();
    await this.persist();
    return project;
  }

  listThreads(projectId: string, archived = false): ProjectThread[] {
    this.getProject(projectId);
    return this.state.threads.filter((thread) => thread.projectId === projectId && Boolean(thread.archivedAt) === archived).sort((a, b) => Number(Boolean(b.favorite)) - Number(Boolean(a.favorite)) || b.updatedAt.localeCompare(a.updatedAt));
  }

  async updateThread(threadId: string, projectId: string, update: { title?: string; archived?: boolean; favorite?: boolean }): Promise<ProjectThread> {
    this.assertThreadProject(threadId, projectId);
    const thread = this.state.threads.find((item) => item.threadId === threadId)!;
    if (update.title !== undefined) {
      const title = update.title.trim().replace(/[\u0000-\u001f]/g, '').slice(0, 80);
      if (!title) throw new Error('对话名称不能为空');
      thread.title = title;
    }
    if (update.archived !== undefined) thread.archivedAt = update.archived ? new Date().toISOString() : undefined;
    if (update.favorite !== undefined) thread.favorite = update.favorite;
    thread.updatedAt = new Date().toISOString();
    await this.persist();
    return thread;
  }

  allThreads(projectId?: string): ProjectThread[] {
    if (projectId) this.getProject(projectId);
    return this.state.threads.filter((thread) => !projectId || thread.projectId === projectId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async deleteThread(threadId: string, projectId: string): Promise<void> {
    this.assertThreadProject(threadId, projectId);
    this.state.threads = this.state.threads.filter((item) => item.threadId !== threadId);
    this.state.tasks = this.state.tasks.filter((item) => item.threadId !== threadId);
    await this.persist();
  }

  listTasks(projectId: string): ProjectTask[] {
    this.getProject(projectId);
    return this.state.tasks.filter((task) => task.projectId === projectId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 200);
  }

  findTaskByClientRequestId(projectId: string, clientRequestId: string): ProjectTask | undefined {
    this.getProject(projectId);
    return this.state.tasks.find((task) => task.projectId === projectId && task.clientRequestId === clientRequestId);
  }

  async outputBaseline(projectId: string): Promise<Record<string, string>> {
    return this.snapshotOutbox(projectId);
  }

  async rememberTask(turnId: string, threadId: string, projectId: string, title: string, attachments: string[] = [], outputBaseline?: Record<string, string>, clientRequestId?: string): Promise<ProjectTask> {
    this.assertThreadProject(threadId, projectId);
    const now = new Date().toISOString();
    let task = this.state.tasks.find((item) => item.turnId === turnId);
    if (!task) {
      task = {
        taskId: turnId, turnId, threadId, projectId,
        title: title.trim().slice(0, 120) || '新任务', status: 'running', startedAt: now, updatedAt: now,
        attachments: [...attachments], outputPaths: [], outputBaseline: outputBaseline ?? await this.snapshotOutbox(projectId), clientRequestId,
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

  async interruptRunningTasks(reason: string): Promise<number> {
    const now = new Date().toISOString();
    let count = 0;
    for (const task of this.state.tasks) {
      if (task.status !== 'running') continue;
      task.status = 'interrupted'; task.updatedAt = now; task.completedAt = now;
      task.errorMessage = reason.trim().slice(0, 500); delete task.outputBaseline; count += 1;
    }
    if (count) await this.persist();
    return count;
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
    const root = this.projectWorkdir(projectId);
    const inbox = this.inbox(projectId);
    const outbox = this.outbox(projectId);
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
