import type { AiProviderKind, AiSettings } from './types';

interface AiProviderPreset {
  provider_kind: AiProviderKind;
  label: string;
  base_url: string;
  requires_api_key: boolean;
}

// Defaults match the provider adapters embedded from Tokn.
export const AI_PROVIDERS: readonly AiProviderPreset[] = [
  { provider_kind: 'openai', label: 'OpenAI', base_url: 'https://api.openai.com/v1', requires_api_key: true },
  { provider_kind: 'deepseek', label: 'DeepSeek', base_url: 'https://api.deepseek.com', requires_api_key: true },
  { provider_kind: 'zai', label: 'Z.ai', base_url: 'https://api.z.ai/api/paas/v4', requires_api_key: true },
  { provider_kind: 'zai_coding_plan', label: 'Z.ai Coding Plan', base_url: 'https://api.z.ai/api/coding/paas/v4', requires_api_key: true },
  { provider_kind: 'zhipu', label: 'Zhipu', base_url: 'https://open.bigmodel.cn/api/paas/v4', requires_api_key: true },
  { provider_kind: 'zhipu_coding_plan', label: 'Zhipu Coding Plan', base_url: 'https://open.bigmodel.cn/api/coding/paas/v4', requires_api_key: true },
  { provider_kind: 'openai_compatible', label: 'OpenAI-compatible', base_url: 'http://127.0.0.1:8080/v1', requires_api_key: false },
];

export const DEFAULT_AI_SETTINGS: AiSettings = {
  provider_kind: 'openai',
  base_url: AI_PROVIDERS[0].base_url,
  model_id: '',
  has_api_key: false,
};

export function normalizeAiBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  try {
    return new URL(trimmed).toString().replace(/\/+$/, '');
  } catch {
    return trimmed;
  }
}
