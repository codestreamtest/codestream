"use strict";

import { Container } from "../container";
import {
	CreateRepoRequest,
	CreateRepoRequestType,
	CreateRepoResponse,
	FetchReposRequest,
	FetchReposRequestType,
	FetchReposResponse,
	FindRepoRequest,
	FindRepoRequestType,
	FindRepoResponse,
	GetRepoRequest,
	GetRepoRequestType,
	GetRepoResponse
} from "../shared/agent.protocol";
import { CSRepository } from "../shared/api.protocol";
import { lspHandler } from "../system";
import { EntityManager, Id } from "./managers";

export class ReposManager extends EntityManager<CSRepository> {
	private loaded = false;

	@lspHandler(CreateRepoRequestType)
	createRepo(request: CreateRepoRequest): Promise<CreateRepoResponse> {
		return Container.instance().api2.createRepo(request);
	}

	@lspHandler(FindRepoRequestType)
	findRepo(request: FindRepoRequest): Promise<FindRepoResponse> {
		return Container.instance().api2.findRepo(request);
	}

	async getAll(): Promise<CSRepository[]> {
		if (!this.loaded) {
			const response = await Container.instance().api2.fetchRepos({});
			for (const repo of response.repos) {
				this.cache.set(repo);
			}
			this.loaded = true;
		}

		return this.cache.getAll();
	}

	protected async fetch(repoId: Id): Promise<CSRepository> {
		const response = await Container.instance().api2.getRepo({ repoId: repoId });
		return response.repo;
	}

	@lspHandler(GetRepoRequestType)
	private async getRepo(request: GetRepoRequest): Promise<GetRepoResponse> {
		const repo = await this.getById(request.repoId);
		return { repo: repo };
	}

	@lspHandler(FetchReposRequestType)
	private async fetchRepos(request: FetchReposRequest): Promise<FetchReposResponse> {
		const repos = await this.getAll();
		if (request.repoIds == null || request.repoIds.length === 0) {
			return { repos: repos };
		}

		return { repos: repos.filter(r => request.repoIds!.includes(r.id)) };
	}
}
