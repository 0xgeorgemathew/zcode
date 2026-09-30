'use strict';
// The ONLY place model ids are chosen (DESIGN §7). The wrapper constructs
// every engine request itself, so nothing outside this allowlist can reach
// the wire.

const DEFAULT_MODEL = 'GLM-5.3-Flash';

// Case-insensitive aliases → official ids (exact ids pass through verbatim;
// they are exactly "GLM-5.3" / "GLM-5.3-Flash").
const ALIASES = new Map([
  ['glm-5.3', 'GLM-5.3'],
  ['5.3', 'GLM-5.3'],
  ['53', 'GLM-5.3'],
  ['glm-5.3-flash', 'GLM-5.3-Flash'],
  ['5.3-flash', 'GLM-5.3-Flash'],
  ['flash', 'GLM-5.3-Flash'],
  ['53f', 'GLM-5.3-Flash'],
]);

const SUPPORTED = ['glm-5.3', 'glm-5.3-flash'];

// Effort enum per the bundle's schema (DESIGN §8). `max` is the default and
// the only guaranteed-portable choice across both models.
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

function normalizeEffort(input) {
  const raw = String(input ?? '').trim().toLowerCase();
  return EFFORT_LEVELS.includes(raw) ? raw : null;
}

// Returns the official model id, or null when input is not allowed.
function normalizeModel(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return null;
  return ALIASES.get(raw.toLowerCase()) ?? null;
}

function unknownModelMessage(input) {
  return (
    `unknown model "${input}". zcode supports only ` +
    `${SUPPORTED[0]} and ${SUPPORTED[1]} ` +
    `(official ids: GLM-5.3, GLM-5.3-Flash).`
  );
}

module.exports = {
  DEFAULT_MODEL,
  normalizeModel,
  unknownModelMessage,
  normalizeEffort,
  EFFORT_LEVELS,
  SUPPORTED,
};
