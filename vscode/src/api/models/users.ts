"use strict";
import { Iterables } from "../../system";
import { CSUser } from "../api";
import { CodeStreamSession, SessionChangedEvent, SessionChangedType } from "../session";
import { CodeStreamCollection, CodeStreamItem } from "./collection";

export class User extends CodeStreamItem<CSUser> {
	constructor(session: CodeStreamSession, user: CSUser) {
		super(session, user);
	}

	get email() {
		return this.entity.email;
	}

	get firstName() {
		return this.entity.firstName;
	}

	get lastName() {
		return this.entity.lastName;
	}

	get fullName() {
		return `${this.entity.firstName || ""} ${this.entity.lastName || ""}`.trim();
	}

	get name() {
		return this.entity.username || this.fullName;
	}

	get lastReads() {
		return this.entity.lastReads || {};
	}

	hasMutedChannel(streamId: string) {
		const preferences = this.entity.preferences;
		if (preferences === undefined) return false;
		const mutedStreams = preferences.mutedStreams;
		if (mutedStreams === undefined) return false;

		return mutedStreams[streamId] === true;
	}
}

export class UserCollection extends CodeStreamCollection<User, CSUser> {
	constructor(session: CodeStreamSession, public readonly teamId: string) {
		super(session);

		this.disposables.push(session.onDidChange(this.onSessionChanged, this));
	}

	protected onSessionChanged(e: SessionChangedEvent) {
		if (e.type !== SessionChangedType.Users) return;

		this.invalidate();
	}

	async getByEmail(
		email: string,
		options: { ignoreCase?: boolean } = { ignoreCase: true }
	): Promise<User | undefined> {
		if (options.ignoreCase) {
			email = email.toLocaleUpperCase();
		}
		return Iterables.find(
			await this.items(),
			u => (options.ignoreCase ? u.email.toLocaleUpperCase() : u.email) === email
		);
	}

	async getByEmails(
		emails: string[],
		options: { ignoreCase?: boolean } = { ignoreCase: true }
	): Promise<Iterable<User>> {
		if (options.ignoreCase) {
			emails = emails.map(email => email.toLocaleUpperCase());
		}
		return Iterables.filter(await this.items(), u =>
			emails.includes(options.ignoreCase ? u.email.toLocaleUpperCase() : u.email)
		);
	}

	async getByName(
		name: string,
		options: { ignoreCase?: boolean } = { ignoreCase: true }
	): Promise<User | undefined> {
		if (options.ignoreCase) {
			name = name.toLocaleUpperCase();
		}
		return Iterables.find(
			await this.items(),
			u => (options.ignoreCase ? u.name.toLocaleUpperCase() : u.name) === name
		);
	}

	protected entityMapper(e: CSUser) {
		return new User(this.session, e);
	}

	protected async fetch() {
		const users = await this.session.api.getUsers();
		return users;
	}
}
