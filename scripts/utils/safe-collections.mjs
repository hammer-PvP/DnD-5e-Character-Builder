/**
 * Return the first value from a known collection without relying on prototype
 * convenience methods supplied by Foundry or another module.
 *
 * This deliberately checks concrete built-in types before any generic shape.
 * Array.prototype and Set.prototype extensions are shared across the Foundry
 * browser context and cannot be trusted as package-private APIs.
 *
 * @param {unknown} value
 * @returns {unknown|null}
 */
export function firstValue(value) {
  if (value == null) return null;
  if (Array.isArray(value)) return value.length ? value[0] : null;

  if (value instanceof Set || value instanceof Map) {
    const iterator = value.values();
    const entry = iterator.next();
    return entry.done ? null : entry.value;
  }

  return null;
}

/**
 * Convert a known collection into an Array without calling non-standard
 * helpers such as .first(), .compact(), or .toArray().
 *
 * @param {unknown} value
 * @returns {unknown[]}
 */
export function valuesArray(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return [...value];
  if (value instanceof Set || value instanceof Map) return Array.from(value.values());
  return [];
}
