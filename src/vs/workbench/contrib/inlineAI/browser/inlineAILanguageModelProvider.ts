/*---------------------------------------------------------------------------------------------
 *  Built-in AI Language Model Provider for Chat
 *  Implements ILanguageModelChatProvider to provide an OpenAI-compatible LLM for the Chat panel.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { DeferredPromise } from '../../../../base/common/async.js';
import { AsyncIterableSource } from '../../../../base/common/async.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { listenStream } from '../../../../base/common/stream.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IRequestService, isSuccess } from '../../../../platform/request/common/request.js';
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

export const INLINE_AI_VENDOR = 'inlineAI';
export const INLINE_AI_EXTENSION_ID = new ExtensionIdentifier('vscode.built-in-ai');

export class InlineAILanguageModelProvider extends Disposable implements ILanguageModelChatProvider {

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	/** Manually fire onDidChange to trigger model resolution in LanguageModelsService */
	fireDidChange(): void {
		this._onDidChange.fire();
	}

	constructor(
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@ILogService private readonly _logService: ILogService,
		@IRequestService private readonly _requestService: IRequestService,
	) {
		super();

		// Re-emit when configuration changes (model name, base URL, etc.)
		this._register(this._configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('inlineAI.apiKey') ||
				e.affectsConfiguration('inlineAI.apiBaseUrl') ||
				e.affectsConfiguration('inlineAI.model') ||
				e.affectsConfiguration('inlineAI.chatModel')) {
				this._onDidChange.fire();
			}
		}));
	}

	async provideLanguageModelChatInfo(
		_options: ILanguageModelChatInfoOptions,
		_token: CancellationToken
	): Promise<ILanguageModelChatMetadataAndIdentifier[]> {
		const apiKey = this._configurationService.getValue<string>('inlineAI.apiKey');
		if (!apiKey) {
			return [];
		}

		const chatModel = this._configurationService.getValue<string>('inlineAI.chatModel')
			|| this._configurationService.getValue<string>('inlineAI.model')
			|| 'gpt-4o-mini';

		return [{
			metadata: {
				extension: INLINE_AI_EXTENSION_ID,
				name: `Built-in AI (${chatModel})`,
				id: `inlineAI:${chatModel}`,
				vendor: INLINE_AI_VENDOR,
				version: '1.0.0',
				family: 'openai-compatible',
				maxInputTokens: 128000,
				maxOutputTokens: 16384,
				isDefaultForLocation: {
					[ChatAgentLocation.Chat]: true,
					[ChatAgentLocation.EditorInline]: true,
					[ChatAgentLocation.Terminal]: true,
				},
				isUserSelectable: true,
				modelPickerCategory: {
					label: 'Built-in AI',
					order: 0,
				},
				capabilities: {
					vision: false,
					toolCalling: true,
					agentMode: true,
				},
			},
			identifier: `inlineAI:${chatModel}`,
		}];
	}

	async sendChatRequest(
		_modelId: string,
		messages: IChatMessage[],
		_from: ExtensionIdentifier | undefined,
		options: ILanguageModelChatRequestOptions,
		token: CancellationToken
	): Promise<ILanguageModelChatResponse> {
		const apiKey = this._configurationService.getValue<string>('inlineAI.apiKey');
		const apiBaseUrl = this._configurationService.getValue<string>('inlineAI.apiBaseUrl') || 'https://api.openai.com/v1';
		const chatModel = this._configurationService.getValue<string>('inlineAI.chatModel')
			|| this._configurationService.getValue<string>('inlineAI.model')
			|| 'gpt-4o-mini';

		if (!apiKey) {
			throw new Error('InlineAI: API Key is not configured. Please set "inlineAI.apiKey" in Settings.');
		}

		const defer = new DeferredPromise<unknown>();
		const stream = new AsyncIterableSource<IChatResponsePart | IChatResponsePart[]>();

		// Extract tools from options if provided
		const tools = options?.tools as IInlineAIToolDefinition[] | undefined;

		// Fire the streaming request in the background
		this._doStreamChatRequest(apiKey, apiBaseUrl, chatModel, messages, options, token, stream, defer, tools)
			.catch(err => {
				this._logService.error('[InlineAI] Chat request failed:', err);
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
		// Simple approximation: ~4 chars per token
		const text = typeof message === 'string'
			? message
			: message.content.map(p => p.type === 'text' ? p.value : '').join('');
		return Math.ceil(text.length / 4);
	}

	private async _doStreamChatRequest(
		apiKey: string,
		apiBaseUrl: string,
		chatModel: string,
		messages: IChatMessage[],
		_options: ILanguageModelChatRequestOptions,
		token: CancellationToken,
		stream: AsyncIterableSource<IChatResponsePart | IChatResponsePart[]>,
		defer: DeferredPromise<unknown>,
		tools?: IInlineAIToolDefinition[],
	): Promise<void> {
		const url = `${apiBaseUrl.replace(/\/+$/, '')}/chat/completions`;

		// Convert messages to OpenAI format
		const openAIMessages = messages.map(msg => {
			// Handle tool result messages
			const toolResultPart = msg.content.find(p => p.type === 'tool_result') as { type: 'tool_result'; toolCallId: string; value: { type: 'text'; value: string }[] } | undefined;
			if (toolResultPart) {
				return {
					role: 'tool' as const,
					tool_call_id: toolResultPart.toolCallId,
					content: toolResultPart.value.map(v => v.value).join(''),
				};
			}

			// Handle assistant messages with tool_calls
			const toolUseParts = msg.content.filter(p => p.type === 'tool_use') as { type: 'tool_use'; name: string; toolCallId: string; parameters: unknown }[];
			if (toolUseParts.length > 0) {
				const textContent = msg.content
					.filter(p => p.type === 'text')
					.map(p => (p as { type: 'text'; value: string }).value)
					.join('');
				return {
					role: 'assistant' as const,
					content: textContent || null,
					tool_calls: toolUseParts.map(tc => ({
						id: tc.toolCallId,
						type: 'function' as const,
						function: {
							name: tc.name,
							arguments: typeof tc.parameters === 'string' ? tc.parameters : JSON.stringify(tc.parameters),
						},
					})),
				};
			}

			return {
				role: msg.role === ChatMessageRole.System ? 'system' as const :
					msg.role === ChatMessageRole.User ? 'user' as const : 'assistant' as const,
				content: msg.content
					.filter(p => p.type === 'text')
					.map(p => (p as { type: 'text'; value: string }).value)
					.join(''),
			};
		});

		// Build request body
		const requestBody: Record<string, unknown> = {
			model: chatModel,
			messages: openAIMessages,
			stream: true,
		};

		// Add tools if provided
		if (tools && tools.length > 0) {
			requestBody.tools = tools.map(t => ({
				type: 'function',
				function: {
					name: t.name,
					description: t.description,
					parameters: t.parameters,
				},
			}));
		}

		const body = JSON.stringify(requestBody);

		const response = await this._requestService.request({
			type: 'POST',
			url,
			data: body,
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${apiKey}`,
			},
			callSite: 'InlineAILanguageModelProvider',
		}, token);

		if (!isSuccess(response)) {
			// Read error body for logging
			let errorText = `API returned status ${response.res.statusCode}`;
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
			throw new Error(errorText);
		}

		// Process SSE stream — now also handles tool_calls
		let buffer = '';
		// Accumulate streaming tool calls: map from index → { id, name, arguments }
		const pendingToolCalls = new Map<number, { id: string; name: string; arguments: string }>();

		await new Promise<void>((resolve, reject) => {
			listenStream(response.stream, {
				onData: (chunk) => {
					if (token.isCancellationRequested) {
						return;
					}
					buffer += chunk.toString();
					// Process complete SSE lines
					const lines = buffer.split('\n');
					buffer = lines.pop() || ''; // Keep incomplete line in buffer

					for (const line of lines) {
						const trimmed = line.trim();
						if (!trimmed || !trimmed.startsWith('data: ')) {
							continue;
						}
						const data = trimmed.slice(6);
						if (data === '[DONE]') {
							continue;
						}
						try {
							const parsed = JSON.parse(data);
							const delta = parsed.choices?.[0]?.delta;
							if (!delta) {
								continue;
							}

							// Handle text content
							if (delta.content) {
								stream.emitOne({ type: 'text', value: delta.content });
							}

							// Handle tool_calls (streaming)
							if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
								for (const tc of delta.tool_calls) {
									const idx = tc.index ?? 0;
									if (!pendingToolCalls.has(idx)) {
										pendingToolCalls.set(idx, {
											id: tc.id || '',
											name: tc.function?.name || '',
											arguments: '',
										});
									}
									const pending = pendingToolCalls.get(idx)!;
									if (tc.id) {
										pending.id = tc.id;
									}
									if (tc.function?.name) {
										pending.name = tc.function.name;
									}
									if (tc.function?.arguments) {
										pending.arguments += tc.function.arguments;
									}
								}
							}
						} catch (e) {
							this._logService.trace('[InlineAI] Failed to parse SSE chunk:', data);
						}
					}
				},
				onError: (err) => reject(err),
				onEnd: () => resolve(),
			}, token);
		});

		// Emit completed tool calls as IChatResponseToolUsePart
		for (const [, tc] of pendingToolCalls) {
			let params: unknown;
			try {
				params = JSON.parse(tc.arguments);
			} catch {
				params = tc.arguments;
			}
			stream.emitOne({
				type: 'tool_use',
				name: tc.name,
				toolCallId: tc.id,
				parameters: params,
			});
		}

		stream.resolve();
		defer.complete(undefined);
	}
}

/**
 * Tool definition format for passing tools to the OpenAI-compatible API.
 */
export interface IInlineAIToolDefinition {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}
