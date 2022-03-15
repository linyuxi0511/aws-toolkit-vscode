/*!
 * Copyright 2022 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode'
import {
    AccountDetails,
    AuthenticationProvider,
    AuthenticationSessionsChangeEvent,
    Session,
} from '../credentials/authentication'
import { createClient } from '../shared/clients/cawsClient'
import { getLogger } from '../shared/logger'
import { DefaultSettingsConfiguration } from '../shared/settingsConfiguration'

async function verifyCookie(cookie: string): Promise<{ username: string }> {
    const client = await createClient(new DefaultSettingsConfiguration())
    await client.setCredentials('', cookie)
    await client.verifySession()

    const username = client.connected ? client.user() : undefined

    if (!username) {
        throw new Error('Invalid session')
    }

    return { username }
}

interface UserMetadata {
    /**
     * Set true if the stored session token is known to be invalid
     */
    invalidSession?: boolean
}

export class CawsAuthStorage {
    private static readonly USERS_MEMENTO_KEY = 'caws/users'
    private static readonly SECRETS_KEY = 'caws/authtokens'

    public constructor(private readonly memento: vscode.Memento, private readonly secrets: vscode.SecretStorage) {}

    public getUsers(): string[] {
        const userdata = this.memento.get<Record<string, unknown>>(CawsAuthStorage.USERS_MEMENTO_KEY, {})

        return Object.keys(userdata)
    }

    public async getSecret(username: string): Promise<string> {
        const cookie = await this.secrets.get(`${CawsAuthStorage.SECRETS_KEY}/${username}`)

        if (!cookie) {
            throw new Error(`No secret found for: ${username}`)
        }

        return cookie
    }

    public async updateUser(username: string, secret: string, metadata?: UserMetadata): Promise<void> {
        const userdata = this.memento.get<Record<string, UserMetadata>>(CawsAuthStorage.USERS_MEMENTO_KEY, {})
        await this.memento.update(CawsAuthStorage.USERS_MEMENTO_KEY, {
            ...userdata,
            [username]: { ...userdata[username], ...metadata },
        })

        return this.secrets.store(`${CawsAuthStorage.SECRETS_KEY}/${username}`, secret)
    }
}

export class CawsAuthenticationProvider implements AuthenticationProvider {
    private readonly _onDidChangeSessions = new vscode.EventEmitter<AuthenticationSessionsChangeEvent<Session>>()
    public readonly onDidChangeSessions = this._onDidChangeSessions.event

    private readonly sessions = new Map<string, Session>()
    private sessionCounter = 0

    public constructor(protected readonly storage: CawsAuthStorage, private readonly getUser = verifyCookie) {}

    public listAccounts(): AccountDetails[] {
        return this.storage.getUsers().map(user => ({
            id: user,
            label: user,
        }))
    }

    /**
     * This creates (and verifies) an account using a cookie.
     *
     * Largely a placeholder method as it is not entirely clear what the UX will look like.
     *
     * TODO: remove this and make `createSession` implicitly create a new account if not provided one.
     * For now, we will supply it with a cookie when the account is not known. If we end up doing SSO,
     * then the `createSession` flow should take the user to the browser. That is, the auth provider
     * itself becomes a prompt.
     */
    public async createAccount(cookie: string): Promise<AccountDetails> {
        const person = await this.getUser(cookie)
        await this.storage.updateUser(person.username, cookie)

        return {
            id: person.username,
            label: person.username,
        }
    }

    /**
     * This method will largely go unused unless multi-tenant auth becomes a requirement.
     */
    public listSessions(): Session[] {
        return Array.from(this.sessions.values())
    }

    /**
     * Currently just returns the cookie if it was valid, otherwise throws.
     */
    private async login(account: Pick<AccountDetails, 'id'>): Promise<Session> {
        try {
            const cookie = await this.storage.getSecret(account.id)
            // Ideally a client should always be immutable after creation
            // Additional context could be bound to derived instances, but best practice is to keep SDK clients 'pure'
            const person = await this.getUser(cookie)
            await this.storage.updateUser(person.username, cookie)

            return {
                accessDetails: cookie,
                accountDetails: { id: person.username, label: person.username },
                id: `session-${(this.sessionCounter += 1)}`,
            }
        } catch (err) {
            // Handle "Decryption Failed" and other potential issues.
            getLogger().debug(`CAWS: failed to login (will clear existing secrets): ${(err as Error).message}`)
            this.storage.updateUser(account.id, '', { invalidSession: true })
            throw err
        }
    }

    /**
     * Creating a new session is the equivalent to logging into the selected account, which may involve
     * some sort of auth flow
     *
     * It's important to note that creating a session does not require knowledge of an account.
     * Usually with an SSO flow we won't know account details until after a session has been created.
     */
    public async createSession(account: AccountDetails): Promise<Session> {
        // ---- CAWS auth flow goes here ---- //
        // using a cookie to login makes the logic a lot clunkier than it should be

        const session = await this.login(account)
        this.sessions.set(session.id, session)

        // ---------------------------------- //

        this._onDidChangeSessions.fire({ added: [session] })

        return session
    }

    public deleteSession(session: Session): void | Promise<void> {
        const old = this.sessions.get(session.id)
        this.sessions.delete(session.id)
        old && this._onDidChangeSessions.fire({ removed: [old] })
    }
}
