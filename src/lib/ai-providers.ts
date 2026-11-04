import type { AiSettings } from './types';

export const DEFAULT_AI_SETTINGS: AiSettings = {
  provider_kind: 'openai_compatible',
  base_url: '',
  model_id: '',
  has_api_key: false,
  host_managed: true,
};
