/*---------------------------------------------------------------------------------------------
 *  Built-in AI Inline Completion Provider
 *  Calls an OpenAI-compatible API to provide inline code completions.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IRequestService, isSuccess, asText } from '../../../../platform/request/common/request.js';
import { InlineCompletions, InlineCompletionsProvider, InlineCompletionContext, InlineCompletionTriggerKind } from '../../../../editor/common/languages.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { Position } from '../../../../editor/common/core/position.js';
import { Range } from '../../../../editor/common/core/range.js';

interface OpenAICompletionChoice {
	text?: string;
	message?: {
		content: string;
	};
}

interface OpenAICompletionResponse {
	choices: OpenAICompletionChoice[];
}

export class InlineAICompletionProvider extends Disposable implements InlineCompletionsProvider {

	readonly groupId = 'inlineAI';
	readonly displayName = 'Built-in AI';
	readonly debounceDelayMs = 200;

	private readonly _onDidChangeInlineCompletions = this._register(new Emitter<void>());
	readonly onDidChangeInlineCompletions: Event<void> = this._onDidChangeInlineCompletions.event;

	constructor(
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@ILogService private readonly _logService: ILogService,
		@IRequestService private readonly _requestService: IRequestService,
	) {
		super();
	}

	async provideInlineCompletions(
		model: ITextModel,
		position: Position,
		context: InlineCompletionContext,
		token: CancellationToken
	): Promise<InlineCompletions | null> {
		// Only trigger on automatic/explicit requests
		if (context.triggerKind !== InlineCompletionTriggerKind.Automatic &&
			context.triggerKind !== InlineCompletionTriggerKind.Explicit) {
			return null;
		}

		const apiKey = this._configurationService.getValue<string>('inlineAI.apiKey');
		const apiBaseUrl = this._configurationService.getValue<string>('inlineAI.apiBaseUrl');
		const modelName = this._configurationService.getValue<string>('inlineAI.model');

		if (!apiKey) {
			return null;
		}

		try {
			const completionText = await this._fetchCompletion(model, position, apiKey, apiBaseUrl || 'https://api.openai.com/v1', modelName || 'gpt-4o-mini', token);
			if (!completionText || token.isCancellationRequested) {
				return null;
			}

			return {
				items: [{
					insertText: completionText,
					range: new Range(position.lineNumber, position.column, position.lineNumber, position.column),
				}]
			};
		} catch (e) {
			this._logService.warn('[InlineAI] Error fetching inline completion:', e);
			return null;
		}
	}

	disposeInlineCompletions(): void {
		// No-op
	}

	private async _fetchCompletion(
		model: ITextModel,
		position: Position,
		apiKey: string,
		apiBaseUrl: string,
		modelName: string,
		token: CancellationToken
	): Promise<string | null> {
		// Get context: prefix (text before cursor) and suffix (text after cursor)
		const maxPrefixLines = 50;
		const maxSuffixLines = 10;

		const startLine = Math.max(1, position.lineNumber - maxPrefixLines);
		const prefix = model.getValueInRange(new Range(
			startLine, 1,
			position.lineNumber, position.column
		));
		const endLine = Math.min(model.getLineCount(), position.lineNumber + maxSuffixLines);
		const suffix = model.getValueInRange(new Range(
			position.lineNumber, position.column,
			endLine, model.getLineMaxColumn(endLine)
		));

		const languageId = model.getLanguageId();
		const fileName = model.uri.path.split('/').pop() || 'untitled';

		// Use Chat Completions API with FIM-style prompt
		const url = `${apiBaseUrl.replace(/\/+$/, '')}/chat/completions`;

		const systemPrompt = `You are a code completion assistant. You are completing code in a ${languageId} file named "${fileName}". Output ONLY the code that should be inserted at the cursor position. Do not include any explanation, markdown formatting, or code fences. Do not repeat the existing code. Output only the new code to insert.`;

		const userPrompt = `Complete the code at the cursor position marked by <CURSOR>:\n\n${prefix}<CURSOR>${suffix}`;

		const body = JSON.stringify({
			model: modelName,
			messages: [
				{ role: 'system', content: systemPrompt },
				{ role: 'user', content: userPrompt }
			],
			max_tokens: 256,
			temperature: 0.2,
			stop: ['\n\n\n', '\r\n\r\n\r\n'],
			stream: false,
		});

		const response = await this._requestService.request({
			type: 'POST',
			url,
			data: body,
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${apiKey}`,
			},
			callSite: 'InlineAICompletionProvider',
		}, token);

		if (!isSuccess(response)) {
			const errorText = await asText(response);
			this._logService.warn(`[InlineAI] API returned status ${response.res.statusCode}: ${errorText}`);
			return null;
		}

		const responseText = await asText(response);
		if (!responseText) {
			return null;
		}

		try {
			const parsed: OpenAICompletionResponse = JSON.parse(responseText);
			const choice = parsed.choices?.[0];
			if (!choice) {
				return null;
			}
			// Support both text (completions API) and message.content (chat completions API)
			const completionText = choice.text ?? choice.message?.content;
			return completionText?.trim() || null;
		} catch (e) {
			this._logService.warn('[InlineAI] Failed to parse API response:', e);
			return null;
		}
	}
}
