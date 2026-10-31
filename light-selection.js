export function availableLightIds(lights) {
  return [...lights.values()].filter(light => light.reachable !== false).map(light => light.id);
}

export function resolveLightIds(lights, requested, includeAll, allowEmpty = false) {
  if (!Array.isArray(requested) || requested.length > 100 || requested.some(id => typeof id !== 'string') || new Set(requested).size !== requested.length) throw new Error('Invalid light selection.');
  const available = includeAll ? availableLightIds(lights) : requested.filter(id => lights.has(id) && lights.get(id).reachable !== false);
  if (!available.length && !(includeAll && allowEmpty)) throw new Error('No selected lights are currently available. Refresh the lights and try again.');
  return available;
}
