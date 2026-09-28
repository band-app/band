/**
 * OpenCode offers every configured provider's models in one flat list. It ids
 * each model `<providerId>/<modelId>` and names it `<provider>/<model>`, e.g.
 * `opencode/big-pickle` / "OpenCode Zen/Big Pickle". The chat's model picker
 * groups that list by provider and shows the model part of the name alone.
 */

export interface ProviderModel {
  id: string;
  name: string;
}

export interface ProviderGroup<T extends ProviderModel> {
  /** The provider part of the model ids, e.g. `opencode`. */
  id: string;
  /** The provider part of the model names, e.g. "OpenCode Zen". */
  name: string;
  models: T[];
}

/** Split at the first slash. A model id may hold more slashes
 *  (`lmstudio/qwen/qwen3-coder-30b`); the provider is the first segment. */
function splitFirst(value: string): [string, string] | null {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) return null;
  return [value.slice(0, slash), value.slice(slash + 1)];
}

/** The model's name without its "<provider>/" prefix. A model whose id and
 *  name don't both carry a provider keeps its full name. */
export function modelNameWithoutProvider(model: ProviderModel): string {
  if (!splitFirst(model.id)) return model.name;
  return splitFirst(model.name)?.[1] ?? model.name;
}

/**
 * Group models by provider, in the order each provider first appears.
 * Models without a provider prefix come back in `ungrouped`, in their order.
 */
export function groupModelsByProvider<T extends ProviderModel>(
  models: T[],
): { groups: ProviderGroup<T>[]; ungrouped: T[] } {
  const groups = new Map<string, ProviderGroup<T>>();
  const ungrouped: T[] = [];
  for (const model of models) {
    const providerId = splitFirst(model.id)?.[0];
    const providerName = splitFirst(model.name)?.[0];
    if (!providerId || !providerName) {
      ungrouped.push(model);
      continue;
    }
    const group = groups.get(providerId);
    if (group) group.models.push(model);
    else groups.set(providerId, { id: providerId, name: providerName, models: [model] });
  }
  return { groups: [...groups.values()], ungrouped };
}
