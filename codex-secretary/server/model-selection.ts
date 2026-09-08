export type CodexModel = {
  id: string;
  model: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  hidden?: boolean;
  supportedReasoningEfforts: Array<{ reasoningEffort: string; description: string }>;
  defaultReasoningEffort: string;
};

export type ModelSelection = {
  model?: CodexModel;
  reasoningEffort?: string;
  migrated: boolean;
};

function supportedEfforts(model: CodexModel): string[] {
  return model.supportedReasoningEfforts.map((item) => item.reasoningEffort);
}

export function compatibleReasoningEffort(model: CodexModel, requested?: string): string | undefined {
  const supported = supportedEfforts(model);
  if (requested && supported.includes(requested)) return requested;

  // GPT-6 Astra does not support the old none/minimal levels. Official
  // migration guidance recommends low for those existing selections.
  if ((requested === 'none' || requested === 'minimal') && supported.includes('low')) return 'low';
  if (supported.includes(model.defaultReasoningEffort)) return model.defaultReasoningEffort;
  return supported[0];
}

export function resolveModelSelection(
  models: CodexModel[],
  requestedModel?: string,
  requestedEffort?: string,
): ModelSelection {
  if (!models.length) return { reasoningEffort: requestedEffort, migrated: false };
  const exact = requestedModel
    ? models.find((item) => item.model === requestedModel || item.id === requestedModel)
    : undefined;
  const model = exact ?? models.find((item) => item.isDefault) ?? models[0];
  const reasoningEffort = compatibleReasoningEffort(model, requestedEffort);
  return {
    model,
    reasoningEffort,
    migrated: Boolean(requestedModel && model.model !== requestedModel) || Boolean(requestedEffort && reasoningEffort !== requestedEffort),
  };
}
