/*---------------------------------------------------------------------------------------------
 *  OpenCode Service — Manages the opencode HTTP server process and HTTP client communication.
 *  Spawns `opencode serve`, provides typed REST API methods, and SSE event streaming.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { IRequestService, isSuccess } from '../../../../platform/request/common/request.js';
import { IRequestContext } from '../../../../base/parts/request/common/request.js';
import { listenStream } from '../../../../base/common/stream.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface IOpencodeSessionInfo {
	id: string;
	title?: string;
	directory: string;
	time: { created: string; updated: string };
	[key: string]: unknown;
}

export interface IOpencodePromptInput {
	parts: IOpencodePromptPart[];
	model?: { providerID: string; modelID: string };
	agent?: string;
	noReply?: boolean;
	format?: string;
	system?: string;
}

export type IOpencodePromptPart =
	| { type: 'text'; text: string }
	| { type: 'file'; mime: string; url: string };

export interface IOpencodeMessageResponse {
	info: IOpencodeAssistantInfo;
	parts: IOpencodeMessagePart[];
}

export interface IOpencodeAssistantInfo {
	id: string;
	role: 'assistant';
	sessionID: string;
	parentID?: string;
	model?: { providerID: string; modelID: string };
	tokens?: { input: number; output: number; cache?: { read: number; write: number } };
	time: { created: string; updated: string; completed?: string };
	error?: unknown;
	[key: string]: unknown;
}

export interface IOpencodeMessagePart {
	type: string;
	[key: string]: unknown;
}

export interface IOpencodeSSEEvent {
	type: string;
	properties: Record<string, unknown>;
}

export interface IOpencodePermissionRequest {
	id: string;
	sessionID: string;
	permission: string;
	patterns: string[];
	metadata: Record<string, unknown>;
	always: string[];
	tool?: { messageID: string; callID: string };
}

// ─── Service Interface ──────────────────────────────────────────────────────

export const IOpencodeService = createDecorator<IOpencodeService>('IOpencodeService');

export interface IOpencodeService {
	readonly _serviceBrand: undefined;

	/** Fires when the server starts or stops */
	readonly onDidChangeStatus: Event<boolean>;

	/** Fires when an SSE event is received from the server */
	readonly onEvent: Event<IOpencodeSSEEvent>;

	/** Fires when a permission request comes from the server */
	readonly onPermissionRequest: Event<IOpencodePermissionRequest>;

	/** Whether the opencode server is currently running */
	isRunning(): boolean;

	/** Get the server base URL */
	getServerUrl(): string | undefined;

	/** Start the opencode server (if not already running) */
	start(): Promise<string>;

	/** Stop the opencode server */
	stop(): void;

	/** Create a new session */
	createSession(directory: string, title?: string): Promise<IOpencodeSessionInfo>;

	/** Send a synchronous prompt (blocks until response is complete) */
	sendMessage(sessionID: string, input: IOpencodePromptInput, directory: string, token: CancellationToken): Promise<IOpencodeMessageResponse>;

	/** Send an async prompt (returns immediately, results via SSE) */
	sendPromptAsync(sessionID: string, input: IOpencodePromptInput, directory: string): Promise<void>;

	/** Abort an active session prompt */
	abortSession(sessionID: string, directory: string): Promise<void>;

	/** Reply to a permission request */
	replyPermission(requestID: string, reply: 'once' | 'always' | 'reject', directory: string, message?: string): Promise<void>;

	/** List pending permission requests */
	listPermissions(directory: string): Promise<IOpencodePermissionRequest[]>;
}

// ─── Implementation ─────────────────────────────────────────────────────────

export class OpencodeService extends Disposable implements IOpencodeService {

	readonly _serviceBrand: undefined;

	private _serverUrl: string | undefined;
	private _running = false;
	private _sseAbort: CancellationTokenSource | undefined;

	private readonly _onDidChangeStatus = this._register(new Emitter<boolean>());
	readonly onDidChangeStatus: Event<boolean> = this._onDidChangeStatus.event;

	private readonly _onEvent = this._register(new Emitter<IOpencodeSSEEvent>());
	readonly onEvent: Event<IOpencodeSSEEvent> = this._onEvent.event;

	private readonly _onPermissionRequest = this._register(new Emitter<IOpencodePermissionRequest>());
	readonly onPermissionRequest: Event<IOpencodePermissionRequest> = this._onPermissionRequest.event;

	constructor(
		@ILogService private readonly _logService: ILogService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IRequestService private readonly _requestService: IRequestService,
		@INotificationService private readonly _notificationService: INotificationService,
	) {
		super();
	}

	isRunning(): boolean {
		return this._running;
	}

	getServerUrl(): string | undefined {
		return this._serverUrl;
	}

	async start(): Promise<string> {
		if (this._running && this._serverUrl) {
			return this._serverUrl;
		}

		const hostname = this._configurationService.getValue<string>('opencode.hostname') || '127.0.0.1';
		const port = this._configurationService.getValue<number>('opencode.port') || 4096;
		const serverUrl = this._configurationService.getValue<string>('opencode.serverUrl');

		// If a custom server URL is provided, use it directly without spawning a child process
		if (serverUrl) {
			this._serverUrl = serverUrl.replace(/\/+$/, '');
			this._running = true;
			this._logService.info(`[OpenCode] Using external server at ${this._serverUrl}`);
			this._onDidChangeStatus.fire(true);
			this._startSSEListener();
			return this._serverUrl;
		}

		// Otherwise, construct URL from hostname:port and assume the user started it externally
		// (In Electron main process, we could spawn `opencode serve`, but browser context can't spawn)
		this._serverUrl = `http://${hostname}:${port}`;
		this._logService.info(`[OpenCode] Connecting to opencode server at ${this._serverUrl}`);

		// Verify the server is reachable
		try {
			const response = await this._requestService.request({
				type: 'GET',
				url: `${this._serverUrl}/path`,
				headers: { 'Content-Type': 'application/json' },
				callSite: 'OpencodeService.start',
			}, CancellationToken.None);

			if (!isSuccess(response)) {
				throw new Error(`Server returned status ${response.res.statusCode}`);
			}

			this._running = true;
			this._onDidChangeStatus.fire(true);
			this._logService.info('[OpenCode] Server connection verified.');
			this._startSSEListener();
			return this._serverUrl;
		} catch (err) {
			this._serverUrl = undefined;
			const msg = err instanceof Error ? err.message : String(err);
			this._logService.error(`[OpenCode] Failed to connect to server: ${msg}`);
			this._notificationService.notify({
				severity: Severity.Error,
				message: `OpenCode: Failed to connect to server at http://${hostname}:${port}. Make sure opencode is running with: opencode serve --hostname ${hostname} --port ${port}`,
			});
			throw new Error(`OpenCode server not reachable at http://${hostname}:${port}: ${msg}`);
		}
	}

	stop(): void {
		this._sseAbort?.cancel();
		this._sseAbort = undefined;
		this._running = false;
		this._serverUrl = undefined;
		this._onDidChangeStatus.fire(false);
		this._logService.info('[OpenCode] Service stopped.');
	}

	async createSession(directory: string, title?: string): Promise<IOpencodeSessionInfo> {
		const url = await this._ensureServer();
		const body: Record<string, unknown> = {};
		if (title) {
			body.title = title;
		}

		const response = await this._requestService.request({
			type: 'POST',
			url: `${url}/session`,
			data: JSON.stringify(body),
			headers: {
				'Content-Type': 'application/json',
				'x-opencode-directory': directory,
			},
			callSite: 'OpencodeService.createSession',
		}, CancellationToken.None);

		return this._readJsonResponse<IOpencodeSessionInfo>(response);
	}

	async sendMessage(
		sessionID: string,
		input: IOpencodePromptInput,
		directory: string,
		token: CancellationToken
	): Promise<IOpencodeMessageResponse> {
		const url = await this._ensureServer();

		const response = await this._requestService.request({
			type: 'POST',
			url: `${url}/session/${sessionID}/message`,
			data: JSON.stringify(input),
			headers: {
				'Content-Type': 'application/json',
				'x-opencode-directory': directory,
			},
			callSite: 'OpencodeService.sendMessage',
		}, token);

		if (!isSuccess(response)) {
			const errorText = await this._readErrorBody(response);
			throw new Error(`OpenCode sendMessage failed: ${errorText}`);
		}

		// The response is streamed as JSON — read all chunks
		const chunks: string[] = [];
		await new Promise<void>((resolve, reject) => {
			listenStream(response.stream, {
				onData: (chunk) => { chunks.push(chunk.toString()); },
				onError: (err) => reject(err),
				onEnd: () => resolve(),
			});
		});

		const raw = chunks.join('');
		return JSON.parse(raw) as IOpencodeMessageResponse;
	}

	async sendPromptAsync(sessionID: string, input: IOpencodePromptInput, directory: string): Promise<void> {
		const url = await this._ensureServer();

		const response = await this._requestService.request({
			type: 'POST',
			url: `${url}/session/${sessionID}/prompt_async`,
			data: JSON.stringify(input),
			headers: {
				'Content-Type': 'application/json',
				'x-opencode-directory': directory,
			},
			callSite: 'OpencodeService.sendPromptAsync',
		}, CancellationToken.None);

		if (response.res.statusCode !== 204 && !isSuccess(response)) {
			const errorText = await this._readErrorBody(response);
			throw new Error(`OpenCode sendPromptAsync failed: ${errorText}`);
		}
	}

	async abortSession(sessionID: string, directory: string): Promise<void> {
		const url = await this._ensureServer();

		await this._requestService.request({
			type: 'POST',
			url: `${url}/session/${sessionID}/abort`,
			data: '{}',
			headers: {
				'Content-Type': 'application/json',
				'x-opencode-directory': directory,
			},
			callSite: 'OpencodeService.abortSession',
		}, CancellationToken.None);
	}

	async replyPermission(requestID: string, reply: 'once' | 'always' | 'reject', directory: string, message?: string): Promise<void> {
		const url = await this._ensureServer();

		const body: Record<string, unknown> = { reply };
		if (message) {
			body.message = message;
		}

		await this._requestService.request({
			type: 'POST',
			url: `${url}/permission/${requestID}/reply`,
			data: JSON.stringify(body),
			headers: {
				'Content-Type': 'application/json',
				'x-opencode-directory': directory,
			},
			callSite: 'OpencodeService.replyPermission',
		}, CancellationToken.None);
	}

	async listPermissions(directory: string): Promise<IOpencodePermissionRequest[]> {
		const url = await this._ensureServer();

		const response = await this._requestService.request({
			type: 'GET',
			url: `${url}/permission`,
			headers: {
				'Content-Type': 'application/json',
				'x-opencode-directory': directory,
			},
			callSite: 'OpencodeService.listPermissions',
		}, CancellationToken.None);

		return this._readJsonResponse<IOpencodePermissionRequest[]>(response);
	}

	// ─── Private ─────────────────────────────────────────────────────────

	private async _ensureServer(): Promise<string> {
		if (!this._running || !this._serverUrl) {
			return this.start();
		}
		return this._serverUrl;
	}

	/**
	 * Start listening for SSE events from the opencode server.
	 * Handles `permission.asked` events by re-emitting them through `onPermissionRequest`.
	 */
	private _startSSEListener(): void {
		if (!this._serverUrl) {
			return;
		}

		this._sseAbort?.cancel();
		const cts = new CancellationTokenSource();
		this._sseAbort = cts;

		const sseUrl = `${this._serverUrl}/event`;
		this._logService.info(`[OpenCode] Starting SSE listener at ${sseUrl}`);

		this._connectSSE(sseUrl, cts.token);
	}

	private async _connectSSE(url: string, token: CancellationToken): Promise<void> {
		try {
			const response = await this._requestService.request({
				type: 'GET',
				url,
				headers: {
					'Accept': 'text/event-stream',
					'Cache-Control': 'no-cache',
				},
				callSite: 'OpencodeService.SSE',
			}, token);

			if (!isSuccess(response)) {
				this._logService.warn(`[OpenCode] SSE connection failed with status ${response.res.statusCode}`);
				this._scheduleSSEReconnect(url, token);
				return;
			}

			let buffer = '';
			await new Promise<void>((resolve) => {
				listenStream(response.stream, {
					onData: (chunk) => {
						if (token.isCancellationRequested) {
							return;
						}
						buffer += chunk.toString();
						const lines = buffer.split('\n');
						buffer = lines.pop() || '';

						for (const line of lines) {
							const trimmed = line.trim();
							if (!trimmed || !trimmed.startsWith('data: ') && !trimmed.startsWith('data:')) {
								continue;
							}
							const data = trimmed.startsWith('data: ') ? trimmed.slice(6) : trimmed.slice(5);
							if (!data) {
								continue;
							}

							try {
								const event = JSON.parse(data) as IOpencodeSSEEvent;
								this._onEvent.fire(event);

								// Route permission requests
								if (event.type === 'permission.asked') {
									this._onPermissionRequest.fire(event.properties as unknown as IOpencodePermissionRequest);
								}
							} catch {
								this._logService.trace('[OpenCode] Failed to parse SSE data:', data);
							}
						}
					},
					onError: (err) => {
						this._logService.warn('[OpenCode] SSE stream error:', err);
						resolve();
					},
					onEnd: () => {
						this._logService.info('[OpenCode] SSE stream ended.');
						resolve();
					},
				}, token);
			});

			// Reconnect if not cancelled
			if (!token.isCancellationRequested) {
				this._scheduleSSEReconnect(url, token);
			}

		} catch (err) {
			if (!token.isCancellationRequested) {
				this._logService.warn('[OpenCode] SSE connection error, will retry:', err);
				this._scheduleSSEReconnect(url, token);
			}
		}
	}

	private _scheduleSSEReconnect(url: string, token: CancellationToken): void {
		if (token.isCancellationRequested) {
			return;
		}
		setTimeout(() => {
			if (!token.isCancellationRequested) {
				this._logService.info('[OpenCode] Reconnecting SSE...');
				this._connectSSE(url, token);
			}
		}, 3000);
	}

	private async _readJsonResponse<T>(response: IRequestContext): Promise<T> {
		if (!isSuccess(response)) {
			const errorText = await this._readErrorBody(response);
			throw new Error(`OpenCode API error: ${errorText}`);
		}

		const chunks: string[] = [];
		await new Promise<void>((resolve, reject) => {
			listenStream(response.stream, {
				onData: (chunk) => { chunks.push(chunk.toString()); },
				onError: (err) => reject(err),
				onEnd: () => resolve(),
			});
		});

		return JSON.parse(chunks.join('')) as T;
	}

	private async _readErrorBody(response: IRequestContext): Promise<string> {
		let errorText = `Status ${response.res.statusCode}`;
		try {
			const chunks: string[] = [];
			await new Promise<void>((resolve, reject) => {
				listenStream(response.stream, {
					onData: (chunk) => { chunks.push(chunk.toString()); },
					onError: (err) => reject(err),
					onEnd: () => resolve(),
				});
			});
			errorText += ': ' + chunks.join('');
		} catch { /* ignore */ }
		return errorText;
	}

	override dispose(): void {
		this.stop();
		super.dispose();
	}
}
