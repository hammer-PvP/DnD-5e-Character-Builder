/**
 * Return the display/name field for a D&D5e Advancement without touching the
 * deprecated Advancement#title getter introduced as a compatibility shim in 6.x.
 *
 * Persisted Character Builder snapshots created before the D&D5e 6 migration may
 * still contain a raw `title` field, so raw source data is accepted as a final
 * fallback. Live 6.x Advancement documents are read through `name`.
 */
export function advancementName(advancement, fallback = "") {
  const source = advancement?._source ?? advancement ?? {};
  const value = advancement?.name ?? source?.name ?? source?.title ?? fallback;
  return String(value ?? fallback);
}

export function normalizedAdvancementName(advancement, fallback = "") {
  return advancementName(advancement, fallback).trim().toLowerCase();
}
