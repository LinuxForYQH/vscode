/*---------------------------------------------------------------------------------------------
 *  Built-in AI Code Generation — Contribution Registration
 *  Registers settings, inline completion provider, and language model provider.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry, ConfigurationScope } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkbenchContribution, WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { ILanguageModelsService } from '../../chat/common/languageModels.js';
import { InlineAICompletionProvider } from './inlineAICompletionProvider.js';
import { InlineAILanguageModelProvider, INLINE_AI_VENDOR } from './inlineAILanguageModelProvider.js';
import { OpencodeLanguageModelProvider, OPENCODE_VENDOR } from './opencodeLanguageModelProvider.js';
import { OpencodeService, IOpencodeService } from './opencodeService.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { ChatViewId } from '../../chat/browser/chat.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';

// ─── Register configuration settings ─────────────────────────────────────────

const configurationRegistry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);
configurationRegistry.registerConfiguration({
	id: 'inlineAI',
	order: 200,
	title: localize('inlineAI.title', "Built-in AI"),
	type: 'object',
	scope: ConfigurationScope.APPLICATION,
	properties: {
		'inlineAI.apiKey': {
			type: 'string',
			default: '',
			description: localize('inlineAI.apiKey', "API Key for the OpenAI-compatible AI service. Required to enable AI code completions and chat."),
			order: 1,
		},
		'inlineAI.apiBaseUrl': {
			type: 'string',
			default: 'https://api.openai.com/v1',
			description: localize('inlineAI.apiBaseUrl', "Base URL for the OpenAI-compatible API (e.g. https://api.openai.com/v1). Supports any API-compatible endpoint."),
			order: 2,
		},
		'inlineAI.model': {
			type: 'string',
			default: 'gpt-4o-mini',
			description: localize('inlineAI.model', "Model name used for inline code completions (e.g. gpt-4o-mini, deepseek-coder, codellama)."),
			order: 3,
		},
		'inlineAI.chatModel': {
			type: 'string',
			default: '',
			description: localize('inlineAI.chatModel', "Model name used for Chat panel conversations. If empty, falls back to 'inlineAI.model'."),
			order: 4,
		},
		'inlineAI.enableInlineCompletions': {
			type: 'boolean',
			default: true,
			description: localize('inlineAI.enableInlineCompletions', "Enable AI-powered inline code completions."),
			order: 5,
		},
		'inlineAI.enableChatModel': {
			type: 'boolean',
			default: true,
			description: localize('inlineAI.enableChatModel', "Enable the built-in AI model for the Chat panel."),
			order: 6,
		},
	}
});

// ─── Register OpenCode configuration settings ───────────────────────────────

configurationRegistry.registerConfiguration({
	id: 'opencode',
	order: 201,
	title: localize('opencode.title', "OpenCode AI"),
	type: 'object',
	scope: ConfigurationScope.APPLICATION,
	properties: {
		'opencode.enabled': {
			type: 'boolean',
			default: true,
			description: localize('opencode.enabled', "Enable the OpenCode AI integration. When enabled, VS Code connects to an opencode HTTP server for AI code generation."),
			order: 1,
		},
		'opencode.hostname': {
			type: 'string',
			default: '127.0.0.1',
			description: localize('opencode.hostname', "Hostname of the opencode HTTP server."),
			order: 2,
		},
		'opencode.port': {
			type: 'number',
			default: 4096,
			description: localize('opencode.port', "Port of the opencode HTTP server."),
			order: 3,
		},
		'opencode.serverUrl': {
			type: 'string',
			default: '',
			description: localize('opencode.serverUrl', "Full URL of the opencode server (e.g. http://127.0.0.1:4096). When set, overrides hostname and port settings."),
			order: 4,
		},
		'opencode.workspaceDirectory': {
			type: 'string',
			default: '',
			description: localize('opencode.workspaceDirectory', "The workspace directory sent to the opencode server. If empty, uses the first open workspace folder."),
			order: 5,
		},
	}
});

// ─── Workbench Contribution ──────────────────────────────────────────────────

class InlineAIContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.inlineAI';

	private _opencodeRegistered = false;

	constructor(
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@ILanguageFeaturesService private readonly _languageFeaturesService: ILanguageFeaturesService,
		@ILanguageModelsService private readonly _languageModelsService: ILanguageModelsService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._register(this._configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('inlineAI') || e.affectsConfiguration('opencode')) {
				this._logService.info('[InlineAI] Configuration changed, re-evaluating providers.');
				// Try to register opencode provider if it wasn't registered yet
				if (e.affectsConfiguration('opencode.enabled') && !this._opencodeRegistered) {
					this._registerOpencodeProvider();
				}
			}
		}));
		this._registerProviders();
	}

	private _registerProviders(): void {
		const apiKey = this._configurationService.getValue<string>('inlineAI.apiKey');

		// ─── Inline Completion Provider ──────────────────────────────────
		const enableInline = this._configurationService.getValue<boolean>('inlineAI.enableInlineCompletions');
		if (enableInline) {
			this._logService.info('[InlineAI] Registering inline completion provider...');
			const completionProvider = this._instantiationService.createInstance(InlineAICompletionProvider);
			this._register(completionProvider);
			this._register(
				this._languageFeaturesService.inlineCompletionsProvider.register('*', completionProvider)
			);
			this._logService.info('[InlineAI] Inline completion provider registered.');
		}

		// ─── Language Model Provider for Chat ────────────────────────────
		const enableChat = this._configurationService.getValue<boolean>('inlineAI.enableChatModel');
		if (enableChat && apiKey) {
			this._logService.info('[InlineAI] Registering language model chat provider...');

			// First register our vendor so LanguageModelsService allows our provider
			try {
				this._languageModelsService.deltaLanguageModelChatProviderDescriptors(
					[{
						vendor: INLINE_AI_VENDOR,
						displayName: 'Built-in AI',
						configuration: undefined,
						managementCommand: undefined,
						when: undefined,
					}],
					[]
				);
			} catch (e) {
				// Vendor might already be registered
				this._logService.trace('[InlineAI] Vendor registration note:', e);
			}

			// Then register the actual provider
			const chatProvider = this._instantiationService.createInstance(InlineAILanguageModelProvider);
			this._register(chatProvider);
			try {
				this._register(
					this._languageModelsService.registerLanguageModelProvider(INLINE_AI_VENDOR, chatProvider)
				);
				this._logService.info('[InlineAI] Language model chat provider registered.');

				// Manually trigger model resolution so the model appears in _modelCache immediately.
				// Without this, the model won't be resolved until onDidChange fires (e.g. config change),
				// because _hasStoredModelForVendor returns false for a brand-new vendor.
				chatProvider.fireDidChange();
			} catch (e) {
				this._logService.warn('[InlineAI] Failed to register chat provider:', e);
			}
		}

		// ─── OpenCode Language Model Provider ────────────────────────────
		this._registerOpencodeProvider();
	}

	private _registerOpencodeProvider(): void {
		if (this._opencodeRegistered) {
			return;
		}

		const opencodeEnabled = this._configurationService.getValue<boolean>('opencode.enabled');
		if (!opencodeEnabled) {
			this._logService.info('[OpenCode] OpenCode is disabled. Set "opencode.enabled": true to enable.');
			return;
		}

		this._logService.info('[OpenCode] Registering OpenCode language model provider...');

		// Register the opencode vendor descriptor first
		try {
			this._languageModelsService.deltaLanguageModelChatProviderDescriptors(
				[{
					vendor: OPENCODE_VENDOR,
					displayName: 'OpenCode AI',
					configuration: undefined,
					managementCommand: undefined,
					when: undefined,
				}],
				[]
			);
			this._logService.info('[OpenCode] Vendor descriptor registered.');
		} catch (e) {
			// Vendor might already be registered — that's OK, we can still register the provider
			this._logService.trace('[OpenCode] Vendor registration note:', e);
		}

		// Register the opencode language model provider
		const opencodeProvider = this._instantiationService.createInstance(OpencodeLanguageModelProvider);
		this._register(opencodeProvider);
		try {
			this._register(
				this._languageModelsService.registerLanguageModelProvider(OPENCODE_VENDOR, opencodeProvider)
			);
			this._opencodeRegistered = true;
			this._logService.info('[OpenCode] Language model provider registered successfully.');

			// Trigger model resolution immediately so the model appears in the picker
			opencodeProvider.fireDidChange();
		} catch (e) {
			this._logService.warn('[OpenCode] Failed to register language model provider:', e);
		}
	}
}

registerWorkbenchContribution2(InlineAIContribution.ID, InlineAIContribution, WorkbenchPhase.AfterRestored);

// ─── Register OpenCode Service Singleton ────────────────────────────────────

registerSingleton(IOpencodeService, OpencodeService, InstantiationType.Delayed);

// ─── Supported AI Models ────────────────────────────────────────────────────

interface IInlineAIModelPreset {
	readonly label: string;
	readonly description: string;
	readonly detail: string;
	readonly modelId: string;
	readonly apiBaseUrl: string;
	readonly keyPlaceholder: string;
}

const SUPPORTED_MODELS: IInlineAIModelPreset[] = [
	{
		label: '$(sparkle) GPT-4o-mini',
		description: 'OpenAI',
		detail: localize('model.gpt4omini.detail', "Fast & affordable, great for code completions"),
		modelId: 'gpt-4o-mini',
		apiBaseUrl: 'https://api.openai.com/v1',
		keyPlaceholder: 'sk-...',
	},
	{
		label: '$(sparkle) GPT-4o',
		description: 'OpenAI',
		detail: localize('model.gpt4o.detail', "Most capable OpenAI model for code generation"),
		modelId: 'gpt-4o',
		apiBaseUrl: 'https://api.openai.com/v1',
		keyPlaceholder: 'sk-...',
	},
	{
		label: '$(sparkle) GPT-4.1',
		description: 'OpenAI',
		detail: localize('model.gpt41.detail', "Latest GPT-4.1 model with improved coding abilities"),
		modelId: 'gpt-4.1',
		apiBaseUrl: 'https://api.openai.com/v1',
		keyPlaceholder: 'sk-...',
	},
	{
		label: '$(sparkle) DeepSeek-V3',
		description: 'DeepSeek',
		detail: localize('model.deepseekv3.detail', "Powerful open-source model, excellent for code"),
		modelId: 'deepseek-chat',
		apiBaseUrl: 'https://api.deepseek.com/v1',
		keyPlaceholder: 'sk-...',
	},
	{
		label: '$(sparkle) DeepSeek-Coder',
		description: 'DeepSeek',
		detail: localize('model.deepseekcoder.detail', "Specialized coding model from DeepSeek"),
		modelId: 'deepseek-coder',
		apiBaseUrl: 'https://api.deepseek.com/v1',
		keyPlaceholder: 'sk-...',
	},
	{
		label: '$(sparkle) Claude 3.5 Sonnet',
		description: 'Anthropic (via compatible endpoint)',
		detail: localize('model.claude35sonnet.detail', "Advanced reasoning & code generation"),
		modelId: 'claude-3.5-sonnet',
		apiBaseUrl: 'https://api.anthropic.com/v1',
		keyPlaceholder: 'sk-ant-...',
	},
	{
		label: '$(sparkle) Qwen-Plus',
		description: localize('model.qwenplus.provider', "Alibaba Cloud"),
		detail: localize('model.qwenplus.detail', "Qwen large model, good balance of cost and capability"),
		modelId: 'qwen-plus',
		apiBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
		keyPlaceholder: 'sk-...',
	},
	{
		label: '$(edit) ' + localize('model.custom.label', "Custom Model..."),
		description: localize('model.custom.description', "Enter custom API base URL and model name"),
		detail: localize('model.custom.detail', "Use any OpenAI-compatible API endpoint"),
		modelId: '__custom__',
		apiBaseUrl: '',
		keyPlaceholder: 'sk-...',
	},
];

// ─── Chat Title Bar: Configure AI Model Key Action ──────────────────────────

registerAction2(class ConfigureInlineAIKeyAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.inlineAI.configureKey',
			title: localize2('inlineAI.configureKey', "Configure AI Model"),
			shortTitle: localize('inlineAI.configureKey.short', "AI Model"),
			icon: Codicon.key,
			f1: true,
			menu: [{
				id: MenuId.ViewTitle,
				when: ContextKeyExpr.equals('view', ChatViewId),
				group: 'navigation',
				order: 5,
			}]
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const quickInputService = accessor.get(IQuickInputService);
		const configurationService = accessor.get(IConfigurationService);
		const notificationService = accessor.get(INotificationService);

		const currentModel = configurationService.getValue<string>('inlineAI.model') || 'gpt-4o-mini';

		// Build quick pick items, mark current model as active
		type ModelPickItem = IInlineAIModelPreset & { picked?: boolean };
		const items: ModelPickItem[] = SUPPORTED_MODELS.map(m => ({
			...m,
			picked: m.modelId === currentModel,
		}));

		// Step 1: Pick a model
		const selected = await quickInputService.pick(items, {
			title: localize('inlineAI.pickModel.title', "Configure AI Model — Select Model"),
			placeHolder: localize('inlineAI.pickModel.placeholder', "Select an AI model to configure"),
			matchOnDescription: true,
			matchOnDetail: true,
		});

		if (!selected) {
			return; // cancelled
		}

		const preset = selected as ModelPickItem;
		let modelId = preset.modelId;
		let apiBaseUrl = preset.apiBaseUrl;

		// If custom model, ask for base URL and model name first
		if (modelId === '__custom__') {
			const currentBaseUrl = configurationService.getValue<string>('inlineAI.apiBaseUrl') || 'https://api.openai.com/v1';
			const inputBaseUrl = await quickInputService.input({
				title: localize('inlineAI.customBaseUrl.title', "Custom Model — API Base URL"),
				prompt: localize('inlineAI.customBaseUrl.prompt', "Enter the base URL for the OpenAI-compatible API"),
				value: currentBaseUrl,
				placeHolder: 'https://api.openai.com/v1',
			});
			if (inputBaseUrl === undefined) {
				return;
			}
			apiBaseUrl = inputBaseUrl;

			const inputModel = await quickInputService.input({
				title: localize('inlineAI.customModel.title', "Custom Model — Model Name"),
				prompt: localize('inlineAI.customModel.prompt', "Enter the model name"),
				value: currentModel,
				placeHolder: 'gpt-4o-mini',
			});
			if (inputModel === undefined) {
				return;
			}
			modelId = inputModel;
		}

		// Step 2: Input API Key
		const currentApiKey = configurationService.getValue<string>('inlineAI.apiKey') || '';
		const apiKey = await quickInputService.input({
			title: localize('inlineAI.inputKey.title2', "Configure {0} — Enter API Key", modelId),
			prompt: localize('inlineAI.inputKey.prompt2', "Enter the API Key for {0}", preset.description || modelId),
			value: currentApiKey,
			password: true,
			placeHolder: preset.keyPlaceholder,
		});

		if (apiKey === undefined) {
			return; // cancelled
		}

		// Save all settings
		await configurationService.updateValue('inlineAI.apiKey', apiKey);
		await configurationService.updateValue('inlineAI.apiBaseUrl', apiBaseUrl);
		await configurationService.updateValue('inlineAI.model', modelId);

		notificationService.info(localize('inlineAI.configured2', "AI Model \"{0}\" configured successfully!", modelId));
	}
});
