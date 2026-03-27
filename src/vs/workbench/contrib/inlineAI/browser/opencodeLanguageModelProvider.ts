/*---------------------------------------------------------------------------------------------
 *  OpenCode Language Model Provider for Chat
 *  Implements ILanguageModelChatProvider to route AI requests through an opencode HTTP server.
 *  Creates opencode sessions, sends prompts, and streams AI responses back to VS Code chat.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { DeferredPromise } from '../../../../base/common/async.js';
import { AsyncIterableSource } from '../../../../base/common/async.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ExtensionIdentifier } from '../../../../platform/extensions/common/extensions.js';
import {
	ChatMessageRole,
	ILanguageModelChatProvider,
	ILanguageModelChatMetadataAndIdentifier,
	ILanguageModelChatResponse,
	ILanguageModelChatRequestOptions,
	ILanguageModelChatInfoOptions,
	IChatMessage,
	IChatResponsePart,
} from '../../../contrib/chat/common/languageModels.js';
import { ChatAgentLocation } from '../../../contrib/chat/common/constants.js';
import {
	IOpencodeService,
	IOpencodePromptPart,
	IOpencodeMessagePart,
	IOpencodeSSEEvent,
} from './opencodeService.js';

export const OPENCODE_VENDOR = 'opencode';
export const OPENCODE_EXTENSION_ID = new ExtensionIdentifier('vscode.opencode');

export class OpencodeLanguageModelProvider extends Disposable implements ILanguageModelChatProvider {

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	/** Map of VS Code chat conversation to opencode session ID */
	private readonly _sessionMap = new Map<string, string>();

	/** Manually fire onDidChange to trigger model resolution in LanguageModelsService */
	fireDidChange(): void {
		this._onDidChange.fire();
	}

	constructor(
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@ILogService private readonly _logService: ILogService,
		@IOpencodeService private readonly _opencodeService: IOpencodeService,
	) {
		super();

		// Re-emit when configuration changes
		this._register(this._configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('opencode')) {
				this._onDidChange.fire();
			}
		}));

		// Re-emit when server status changes
		this._register(this._opencodeService.onDidChangeStatus(() => {
			this._onDidChange.fire();
		}));
	}

	async provideLanguageModelChatInfo(
		_options: ILanguageModelChatInfoOptions,
		_token: CancellationToken
	): Promise<ILanguageModelChatMetadataAndIdentifier[]> {
		const enabled = this._configurationService.getValue<boolean>('opencode.enabled');
		if (!enabled) {
			return [];
		}

		return [{
			metadata: {
				extension: OPENCODE_EXTENSION_ID,
				name: 'OpenCode AI',
				id: 'opencode:agent',
				vendor: OPENCODE_VENDOR,
				version: '1.0.0',
				family: 'opencode',
				maxInputTokens: 200000,
				maxOutputTokens: 32768,
				isDefaultForLocation: {
					[ChatAgentLocation.Chat]: true,
					[ChatAgentLocation.EditorInline]: true,
					[ChatAgentLocation.Terminal]: true,
				},
				isUserSelectable: true,
				modelPickerCategory: {
					label: 'OpenCode',
					order: 0,
				},
				capabilities: {
					vision: false,
					toolCalling: true,
					agentMode: true,
				},
			},
			identifier: 'opencode:agent',
		}];
	}

	async sendChatRequest(
		_modelId: string,
		messages: IChatMessage[],
		_from: ExtensionIdentifier | undefined,
		_options: ILanguageModelChatRequestOptions,
		token: CancellationToken
	): Promise<ILanguageModelChatResponse> {
		const defer = new DeferredPromise<unknown>();
		const stream = new AsyncIterableSource<IChatResponsePart | IChatResponsePart[]>();

		this._doSendRequest(messages, token, stream, defer)
			.catch(err => {
				this._logService.error('[OpenCode] Chat request failed:', err);
				stream.reject(err instanceof Error ? err : new Error(String(err)));
				defer.error(err instanceof Error ? err : new Error(String(err)));
			});

		return {
			result: defer.p,
			stream: stream.asyncIterable,
		};
	}

	async provideTokenCount(
		_modelId: string,
		message: string | IChatMessage,
		_token: CancellationToken
	): Promise<number> {
		// Approximate token count: ~4 chars per token
		const text = typeof message === 'string'
			? message
			: message.content.map(p => p.type === 'text' ? p.value : '').join('');
		return Math.ceil(text.length / 4);
	}

	private async _doSendRequest(
		messages: IChatMessage[],
		token: CancellationToken,
		stream: AsyncIterableSource<IChatResponsePart | IChatResponsePart[]>,
		defer: DeferredPromise<unknown>,
	): Promise<void> {
		// 1. Ensure the opencode server is running
		await this._opencodeService.start();

		// 2. Get the working directory (from VS Code workspace)
		const workspaceFolders = this._configurationService.getValue<string>('opencode.workspaceDirectory') || process.cwd?.() || '.';

		// 3. Get or create a session for this conversation
		const conversationKey = this._getConversationKey(messages);
		let sessionID = this._sessionMap.get(conversationKey);

		if (!sessionID) {
			this._logService.info('[OpenCode] Creating new session...');
			const session = await this._opencodeService.createSession(workspaceFolders);
			sessionID = session.id;
			this._sessionMap.set(conversationKey, sessionID);
			this._logService.info(`[OpenCode] Session created: ${sessionID}`);
		}

		// 4. Convert VS Code messages to opencode prompt parts
		const promptParts = this._convertMessagesToPromptParts(messages);

		// 5. Set up SSE listener for streaming text parts
		const sseDisposable = this._opencodeService.onEvent((event: IOpencodeSSEEvent) => {
			if (token.isCancellationRequested) {
				return;
			}
			this._handleSSEEvent(event, sessionID!, stream);
		});

		// 6. Set up cancellation
		const cancelListener = token.onCancellationRequested(() => {
			this._logService.info(`[OpenCode] Aborting session ${sessionID}...`);
			this._opencodeService.abortSession(sessionID!, workspaceFolders).catch(err => {
				this._logService.warn('[OpenCode] Failed to abort session:', err);
			});
		});

		try {
			// 7. Send the synchronous prompt (blocks until AI is done)
			const response = await this._opencodeService.sendMessage(
				sessionID,
				{ parts: promptParts },
				workspaceFolders,
				token,
			);

			// 8. Process the response parts
			this._processResponseParts(response.parts, stream);

			stream.resolve();
			defer.complete(undefined);
		} catch (err) {
			if (token.isCancellationRequested) {
				stream.resolve();
				defer.complete(undefined);
			} else {
				throw err;
			}
		} finally {
			sseDisposable.dispose();
			cancelListener.dispose();
		}
	}

	/**
	 * Convert the full VS Code chat messages into opencode PromptInput.parts.
	 * We extract the latest user message as the prompt text.
	 */
	private _convertMessagesToPromptParts(messages: IChatMessage[]): IOpencodePromptPart[] {
		const parts: IOpencodePromptPart[] = [];

		// Collect all system messages as context
		const systemMessages = messages.filter(m => m.role === ChatMessageRole.System);
		if (systemMessages.length > 0) {
			const systemText = systemMessages
				.map(m => m.content.filter(p => p.type === 'text').map(p => (p as { type: 'text'; value: string }).value).join(''))
				.join('\n\n');
			if (systemText) {
				parts.push({ type: 'text', text: `[System Context]\n${systemText}` });
			}
		}

		// Find the latest user message — this is the main prompt
		const userMessages = messages.filter(m => m.role === ChatMessageRole.User);
		if (userMessages.length > 0) {
			const lastUser = userMessages[userMessages.length - 1];
			const userText = lastUser.content
				.filter(p => p.type === 'text')
				.map(p => (p as { type: 'text'; value: string }).value)
				.join('');

			if (userText) {
				parts.push({ type: 'text', text: userText });
			}
		}

		// If there's conversation history (assistant messages), prepend as context
		const assistantMessages = messages.filter(m => m.role === ChatMessageRole.Assistant);
		if (assistantMessages.length > 0) {
			const historyText = assistantMessages
				.map(m => m.content.filter(p => p.type === 'text').map(p => (p as { type: 'text'; value: string }).value).join(''))
				.filter(t => t)
				.join('\n---\n');
			if (historyText) {
				// Prepend history before the user message
				parts.unshift({ type: 'text', text: `[Previous Assistant Responses]\n${historyText}` });
			}
		}

		if (parts.length === 0) {
			parts.push({ type: 'text', text: 'Hello' });
		}

		return parts;
	}

	/**
	 * Handle SSE events from the opencode server.
	 * Text events and tool usage events are streamed to the VS Code chat.
	 */
	private _handleSSEEvent(event: IOpencodeSSEEvent, sessionID: string, stream: AsyncIterableSource<IChatResponsePart | IChatResponsePart[]>): void {
		const props = event.properties;

		// Only process events for our session
		if (props.sessionID && props.sessionID !== sessionID) {
			return;
		}

		switch (event.type) {
			case 'message.text.delta': {
				// Streaming text delta from the assistant
				const delta = props.delta as string | undefined;
				if (delta) {
					stream.emitOne({ type: 'text', value: delta });
				}
				break;
			}
			case 'session.error': {
				this._logService.error('[OpenCode] Session error:', props.error);
				break;
			}
			case 'permission.asked': {
				this._logService.info('[OpenCode] Permission requested:', props);
				break;
			}
		}
	}

	/**
	 * Process the final response parts from the opencode `sendMessage` API.
	 * Converts opencode message parts to VS Code IChatResponsePart.
	 */
	private _processResponseParts(parts: IOpencodeMessagePart[], stream: AsyncIterableSource<IChatResponsePart | IChatResponsePart[]>): void {
		for (const part of parts) {
			switch (part.type) {
				case 'text': {
					const text = (part as { type: 'text'; content?: string; text?: string }).content
						?? (part as { type: 'text'; text?: string }).text
						?? '';
					if (text) {
						stream.emitOne({ type: 'text', value: text });
					}
					break;
				}
				case 'tool-invocation':
				case 'tool-result': {
					// Convert tool usage to VS Code tool_use part
					const toolName = (part as Record<string, unknown>).toolName as string || 'unknown';
					const toolCallId = (part as Record<string, unknown>).toolCallId as string || '';
					const args = (part as Record<string, unknown>).args ?? (part as Record<string, unknown>).input ?? {};

					stream.emitOne({
						type: 'tool_use',
						name: toolName,
						toolCallId: toolCallId,
						parameters: args,
					});
					break;
				}
				case 'thinking': {
					const thinking = (part as { type: 'thinking'; content?: string; text?: string }).content
						?? (part as { type: 'thinking'; text?: string }).text
						?? '';
					if (thinking) {
						stream.emitOne({ type: 'thinking', value: thinking });
					}
					break;
				}
				default: {
					// Log unknown part types for debugging
					this._logService.trace(`[OpenCode] Unknown response part type: ${part.type}`);
					break;
				}
			}
		}
	}

	/**
	 * Generate a stable key for the conversation to reuse sessions.
	 * Uses the first user message as a rough identifier.
	 */
	private _getConversationKey(messages: IChatMessage[]): string {
		// Use the content of the first user message as a rough key
		const firstUser = messages.find(m => m.role === ChatMessageRole.User);
		if (firstUser) {
			const text = firstUser.content
				.filter(p => p.type === 'text')
				.map(p => (p as { type: 'text'; value: string }).value)
				.join('')
				.slice(0, 100);
			return `session:${text}`;
		}
		return `session:default`;
	}
}
