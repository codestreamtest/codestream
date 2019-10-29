"use strict";
import * as fs from "fs";
import * as path from "path";
import {
	Disposable,
	Emitter,
	Event,
	WorkspaceFolder,
	WorkspaceFoldersChangeEvent
} from "vscode-languageserver";
import { URI } from "vscode-uri";
import { SessionContainer } from "../container";
import { Logger } from "../logger";
import { MarkersManager } from "../managers/markersManager";
import { MatchReposRequest, MatchReposResponse, RepoMap } from "../protocol/agent.protocol.repos";
import { CSRepository } from "../protocol/api.protocol";
import { CodeStreamSession } from "../session";
import { Iterables, Objects, Strings, TernarySearchTree } from "../system";
import { Disposables } from "../system/disposable";
import { GitRepository, GitService } from "./gitService";

export class GitRepositories {
	private _onDidChange = new Emitter<void>();
	get onDidChange(): Event<void> {
		return this._onDidChange.event;
	}

	private _onCommitHashChanged = new Emitter<GitRepository>();
	get onCommitHashChanged(): Event<GitRepository> {
		return this._onCommitHashChanged.event;
	}

	private _disposable: Disposable | undefined;
	private readonly _repositoryTree: TernarySearchTree<GitRepository>;
	private _searchPromise: Promise<void> | undefined;
	private _syncPromise: Promise<void> | undefined;
	private _repositoryMappingSyncPromise: Promise<{ [key: string]: boolean }> | undefined;

	constructor(private readonly _git: GitService, public readonly session: CodeStreamSession) {
		this._repositoryTree = TernarySearchTree.forPaths();

		this._searchPromise = this.start();
	}

	dispose() {
		this._disposable && this._disposable.dispose();
	}

	async find(predicate: (repo: GitRepository) => boolean) {
		const tree = await this.getRepositoryTree();
		return Iterables.find(tree.values(), predicate);
	}

	async get(): Promise<Iterable<GitRepository>> {
		const tree = await this.getRepositoryTree();
		return tree.values();
	}

	async getById(id: string): Promise<GitRepository | undefined> {
		const tree = await this.getRepositoryTree();
		const result = Iterables.find(tree.values(), r => r.id === id);
		return result;
	}

	async getByFilePath(filePath: string): Promise<GitRepository | undefined> {
		const tree = await this.getRepositoryTree();
		let result = tree.findSubstr(filePath);
		if (!result) {
			await this.repositorySearchByDocument({
				uri: URI.file(filePath).toString()
			});
			const tree = await this.getRepositoryTree();
			result = tree.findSubstr(filePath);
		}
		return result;
	}

	async syncKnownRepositories(repos: CSRepository[]) {
		Logger.debug(`syncing KnownRepositories...`);
		const remoteToRepoMap = await this.getKnownRepositories();

		// Don't call: const tree = await this.getRepositoryTree(); because it waits on the _syncPromise

		if (this._searchPromise !== undefined) {
			await this._searchPromise;
			this._searchPromise = undefined;
		}

		const tree = this._repositoryTree;
		const reposToMap = [];
		for (const repo of tree.values()) {
			Logger.debug(`RepositoryTree repo=${repo.path} repoId=${repo.id}`);
			// TODO: Probably should update the repo even for ones that have matches, but right now we are only using the repo id
			if (repo.id === undefined) {
				await repo.searchForKnownRepository(remoteToRepoMap);
			}

			if (repo.id && repo.path) {
				const found = repos.find(_ => _.id === repo.id);
				if (found) {
					reposToMap.push({
						repoId: repo.id,
						path: repo.path
					});
				}
			}
		}
		if (reposToMap.length) {
			SessionContainer.instance().repositoryMappings.mapRepos({
				repos: reposToMap
			});
		}
	}

	private async start() {
		// Wait for the session to be ready first
		await this.session.ready();

		const disposables: Disposable[] = [
			this.session.onDidChangeRepositories(this.onRepositoriesChanged, this)
		];

		if (this.session.agent.supportsConfiguration) {
			disposables.push(
				this.session.workspace.onDidChangeWorkspaceFolders(this.onWorkspaceFoldersChanged, this)
			);
		}

		this._disposable = Disposables.from(...disposables);

		return this.onWorkspaceFoldersChanged();
	}

	async onRepositoriesChanged(repos: CSRepository[]) {
		if (this._syncPromise !== undefined) {
			await this._syncPromise;
		}

		this._syncPromise = this.syncKnownRepositories(repos);
	}

	private async onWorkspaceFoldersChanged(e?: WorkspaceFoldersChangeEvent) {
		let initializing = false;
		const repoMap: RepoMap[] = [];
		if (e === undefined) {
			initializing = true;
			e = {
				added: await this.session.getWorkspaceFolders(),
				removed: []
			} as WorkspaceFoldersChangeEvent;

			Logger.log(`Starting repository search in ${e.added.length} folders`);
		}

		let allAddedRepositories: GitRepository[] = [];
		for (const f of e.added) {
			if (URI.parse(f.uri).scheme !== "file") continue;

			// Search for and add all repositories (nested and/or submodules)
			const repositories = await this.repositorySearch(f, this.session.workspace);
			allAddedRepositories = [...allAddedRepositories, ...repositories];
		}

		// for all repositories without a CodeStream repo ID, ask the server for matches,
		// and create new CodeStream repos for any we have found that aren't known to the team
		const unassignedRepositories = allAddedRepositories.filter(repo => !repo.id);
		if (unassignedRepositories.length > 0) {
			const repoInfo: MatchReposRequest = { repos: [] };
			await Promise.all(unassignedRepositories.map(async repo => {
				const remotes = (await repo.getRemotes()).map(r => r.path);
				const knownCommitHashes = await MarkersManager.getKnownCommitHashes(repo.path);
				repoInfo.repos.push({ remotes, knownCommitHashes });
			}));
			const repoMatches = await this.session.api.matchRepos(repoInfo);
			for (let i = 0; i < repoMatches.repos.length; i++) {
				unassignedRepositories[i].setKnownRepository(repoMatches.repos[i]);
			}
		}

		for (const r of allAddedRepositories) {
			this._repositoryTree.set(r.path, r);
			if (initializing && r.id) {
				repoMap.push({
					repoId: r.id,
					path: r.path
				});
			}
		}

		for (const f of e.removed) {
			const uri = URI.parse(f.uri);
			if (uri.scheme !== "file") continue;

			const fsPath = uri.fsPath;
			const filteredTree = this._repositoryTree.findSuperstr(fsPath);
			const reposToDelete =
				filteredTree !== undefined
					? [
							// Since the filtered tree will have keys that are relative to the fsPath, normalize to the full path
							...Iterables.map<[GitRepository, string], [GitRepository, string]>(
								filteredTree.entries(),
								([r, k]) => [r, path.join(fsPath, k)]
							)
					  ]
					: [];

			const repo = this._repositoryTree.get(fsPath);
			if (repo !== undefined) {
				reposToDelete.push([repo, fsPath]);
			}

			for (const [, k] of reposToDelete) {
				this._repositoryTree.delete(k);
			}
		}

		SessionContainer.instance().repositoryMappings.setRepoMappingData({
			repos: repoMap,
			skipRepositoryIntegration: true
		});

		if (!initializing) {
			// Defer the event trigger enough to let everything unwind
			setImmediate(() => this._onDidChange.fire(undefined));
		}

		await this.monitorRepos();
	}

	async setKnownRepository(
		repos: { repoId: string; path: string }[]
	): Promise<{ [key: string]: boolean } | undefined> {
		if (!repos || !repos.length) return undefined;

		if (this._repositoryMappingSyncPromise !== undefined) {
			await this._repositoryMappingSyncPromise;
			this._repositoryMappingSyncPromise = undefined;
		}

		this._repositoryMappingSyncPromise = this.setKnownRepositoryCore(repos);
		return await this._repositoryMappingSyncPromise;
	}

	async setKnownRepositoryCore(
		repos: { repoId: string; path: string }[]
	): Promise<{ [key: string]: boolean }> {
		const found: { [key: string]: boolean } = {};
		for (const r in repos) {
			const repo = repos[r];

			const repositories = await this.repositorySearch({
				uri: repo.path,
				name: path.basename(repo.path)
			});

			Logger.debug(`repositorySearch found ${repositories.length} repos`);
			for (const r of repositories) {
				if (!r.id) {
					Logger.debug(`Skipping ${r.path} (no id)`);
					continue;
				}

				this._repositoryTree.set(r.path, r);
				found[r.id] = true;
				Logger.debug(`Added ${r.path} id=${r.id}`);
			}
		}
		return found;
	}

	private async repositorySearchByDocument(document: { uri: string }) {
		const dir = path.dirname(document.uri.toString());
		Logger.log(`Starting repository search by file in ${dir} folder`);
		let found;
		if (URI.parse(document.uri).scheme === "file") {
			// Search for and add all repositories (nested and/or submodules)
			const repositories = await this.repositorySearch({
				uri: dir,
				name: path.basename(document.uri)
			});

			Logger.log(`repositorySearch found ${repositories.length} repos`);
			found = repositories && repositories.length;
			for (const r of repositories) {
				this._repositoryTree.set(r.path, r);
			}
		}
		if (found) {
			await this.monitorRepos();
		}
	}

	private _monitors: fs.FSWatcher[] = [];
	private async monitorRepos() {
		for (const monitor of this._monitors) {
			monitor.close();
		}
		this._monitors = [];

		const repos = this._repositoryTree.values();
		for (const repo of repos) {
			const logFile = path.join(repo.path, ".git", "logs", "HEAD");
			try {
				const watcher = fs.watch(logFile, () => {
					this._onCommitHashChanged.fire(repo);
				});
				this._monitors.push(watcher);
			} catch (err) {
				Logger.error(err);
			}
		}
	}

	private async getKnownRepositories() {
		const resp = await SessionContainer.instance().repos.get();
		const remotesToRepo = Iterables.flatMap(
			resp.repos,
			r =>
				r.remotes !== undefined && r.remotes.length !== 0
					? r.remotes.map<[string, CSRepository]>(remote => [remote.normalizedUrl, r])
					: ([[(r as any).normalizedUrl as string, r]] as [string, CSRepository][])
			// r => r.remotes !== undefined && r.remotes.length !== 0
		);
		return new Map<string, CSRepository>(remotesToRepo);
	}

	private async getRepositoryTree(): Promise<TernarySearchTree<GitRepository>> {
		if (this._searchPromise !== undefined) {
			await this._searchPromise;
			this._searchPromise = undefined;
		}

		if (this._syncPromise !== undefined) {
			await this._syncPromise;
			this._syncPromise = undefined;
		}

		if (this._repositoryMappingSyncPromise !== undefined) {
			await this._repositoryMappingSyncPromise;
			this._repositoryMappingSyncPromise = undefined;
		}

		return this._repositoryTree;
	}

	private async repositorySearch(
		folder: WorkspaceFolder,
		workspace: any = null
	): Promise<GitRepository[]> {
		// const workspace = this.session.workspace;
		const folderUri = URI.parse(folder.uri);

		// TODO: Make this configurable
		const depth = 2;
		// configuration.get<number>(
		// 	configuration.name("advanced")("repositorySearchDepth").value,
		// 	folderUri
		// );

		const remoteToRepoMap = await this.getKnownRepositories();

		Logger.log(`Searching for repositories (depth=${depth}) in '${folderUri.fsPath}' ...`);

		const start = process.hrtime();

		const repositories: GitRepository[] = [];

		let rootPath;
		try {
			rootPath = await this._git.getRepoRoot(folderUri.fsPath, true);
		} catch {}
		if (rootPath) {
			Logger.log(`Repository found in '${rootPath}'`);
			const repo = new GitRepository(rootPath, true, folder, remoteToRepoMap);
			await repo.ensureSearchComplete();
			repositories.push(repo);
		}

		if (depth <= 0) {
			Logger.log(
				`Searching for repositories (depth=${depth}) in '${
					folderUri.fsPath
				}' took ${Strings.getDurationMilliseconds(start)} ms`
			);

			return repositories;
		}

		let excludes: { [key: string]: boolean } = Object.create(null);
		if (workspace && this.session.agent.supportsConfiguration) {
			// Get any specified excludes -- this is a total hack, but works for some simple cases and something is better than nothing :)
			const [files, search] = await workspace.getConfiguration([
				{
					section: "files.exclude",
					scopeUri: folderUri.toString()
				},
				{
					section: "search.exclude",
					scopeUri: folderUri.toString()
				}
			]);

			excludes = {
				...(files || {}),
				...(search || {})
			};

			const excludedPaths = [
				...Iterables.filterMap(Objects.entries(excludes), ([key, value]) => {
					if (!value) return undefined;
					if (key.startsWith("**/")) return key.substring(3);
					return key;
				})
			];

			excludes = excludedPaths.reduce(
				(accumulator, current) => {
					accumulator[current] = true;
					return accumulator;
				},
				Object.create(null) as any
			);
		}

		let paths;
		try {
			paths = await this.repositorySearchCore(folderUri.fsPath, depth, excludes);
		} catch (ex) {
			if (/no such file or directory/i.test(ex.message || "")) {
				Logger.log(
					`Searching for repositories (depth=${depth}) in '${folderUri.fsPath}' FAILED${
						ex.message ? ` (${ex.message})` : ""
					}`
				);
			} else {
				Logger.error(
					ex,
					`Searching for repositories (depth=${depth}) in '${folderUri.fsPath}' FAILED`
				);
			}

			return repositories;
		}

		for (let p of paths) {
			p = path.dirname(p);
			// If we are the same as the root, skip it
			if (Strings.normalizePath(p) === rootPath) continue;

			let rp;
			try {
				rp = await this._git.getRepoRoot(p, true);
			} catch {}
			if (!rp) continue;

			Logger.log(`Repository found in '${rp}'`);
			const repo = new GitRepository(rp, false, folder, remoteToRepoMap);
			await repo.ensureSearchComplete();
			repositories.push(repo);
		}

		Logger.log(
			`Searching for repositories (depth=${depth}) in '${
				folderUri.fsPath
			}' took ${Strings.getDurationMilliseconds(start)} ms`
		);

		return repositories;
	}

	private async repositorySearchCore(
		root: string,
		depth: number,
		excludes: { [key: string]: boolean },
		repositories: string[] = []
	): Promise<string[]> {
		return new Promise<string[]>((resolve, reject) => {
			fs.readdir(root, async (err, files) => {
				if (err != null) {
					reject(err);
					return;
				}

				if (files.length === 0) {
					resolve(repositories);
					return;
				}

				const folders: string[] = [];

				const promises = files.map(file => {
					const fullPath = path.resolve(root, file);

					return new Promise<void>((res, rej) => {
						fs.stat(fullPath, (err, stat) => {
							if (file === ".git") {
								repositories.push(fullPath);
							} else if (
								err == null &&
								excludes[file] !== true &&
								stat != null &&
								stat.isDirectory()
							) {
								folders.push(fullPath);
							}

							res();
						});
					});
				});

				await Promise.all(promises);

				if (depth-- > 0) {
					for (const folder of folders) {
						await this.repositorySearchCore(folder, depth, excludes, repositories);
					}
				}

				resolve(repositories);
			});
		});
	}
}
