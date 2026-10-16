'use strict';
// The ONLY place model ids are chosen (DESIGN §7). The wrapper constructs
// every engine request itself, so nothing outside this allowlist can reach
// the wire.

const fs = require('node:fs');

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

// --- supported effort levels per model ---------------------------------------
//
// The engine rejects an unsupported reasoning level only after it has been
// spawned and a session opened (GLM-5.3 refused `medium` that way in a real
// run). The levels live in the engine's builtin provider config
// (config/provider/zcode-builtin.json, the path `zcode doctor` reports):
// modelConfigRules.modelRules[] = {modelMatch: <regex>, config:
// {optionSpecs: {reasoningLevel: {values: […]}}}}. Later rules refine
// earlier ones (a generic `glm-5` rule lists disabled/enabled; the
// `glm-5.3(-flash)?` rule after it lists low/high/max), so the LAST matching
// rule that lists values wins. Unreadable or unmatched → the table below
// (observed in zcode-builtin.json shipped with ZCode 0.16.x).
const FALLBACK_LEVELS = {
  'GLM-5.3': ['low', 'high', 'max'],
  'GLM-5.3-Flash': ['low', 'high', 'max'],
};
const OFFICIAL_IDS = Object.keys(FALLBACK_LEVELS);

const levelCache = new Map(); // path:mtime:size → parsed rules

function readRules(file) {
  try {
    const st = fs.statSync(file);
    const key = `${file}:${st.mtimeMs}:${st.size}`;
    if (!levelCache.has(key)) {
      const json = JSON.parse(fs.readFileSync(file, 'utf8'));
      const rules = json && json.config && json.config.modelConfigRules && json.config.modelConfigRules.modelRules;
      levelCache.set(key, Array.isArray(rules) ? rules : []);
    }
    return levelCache.get(key);
  } catch {
    return [];
  }
}

function builtinConfigPath(env) {
  try {
    const { resolveEngine, resolveBuiltinProviderConfig } = require('./engine.js');
    return resolveBuiltinProviderConfig(resolveEngine(env), env);
  } catch {
    return null;
  }
}

// Efforts (a subset of EFFORT_LEVELS, in enum order) the model accepts.
function supportedEfforts(model, { env = process.env, builtinConfig } = {}) {
  const file = builtinConfig || builtinConfigPath(env);
  let values = null;
  if (file) {
    for (const rule of readRules(file)) {
      let match = false;
      try {
        match = new RegExp(`^(?:${rule.modelMatch})$`, 'i').test(model);
      } catch {
        /* a malformed pattern matches nothing */
      }
      const v = match && rule.config && rule.config.optionSpecs && rule.config.optionSpecs.reasoningLevel
        && rule.config.optionSpecs.reasoningLevel.values;
      if (Array.isArray(v)) values = v;
    }
  }
  const levels = values ? EFFORT_LEVELS.filter((l) => values.includes(l)) : [];
  return levels.length ? levels : FALLBACK_LEVELS[model] || [];
}

// {modelId: [levels]} for every supported model (doctor).
function modelLevels(opts) {
  return Object.fromEntries(OFFICIAL_IDS.map((id) => [id, supportedEfforts(id, opts)]));
}

// null when `effort` is usable with `model`, else the one-line refusal.
// `source` names where the value came from ("--effort", "contract effort").
function effortProblem(model, effort, { source = '--effort', ...opts } = {}) {
  const levels = supportedEfforts(model, opts);
  if (levels.includes(effort)) return null;
  return `${source} ${effort} is not supported by ${model} (supported: ${levels.join(', ')}).`;
}

module.exports = {
  supportedEfforts,
  modelLevels,
  effortProblem,
  FALLBACK_LEVELS,
  DEFAULT_MODEL,
  normalizeModel,
  unknownModelMessage,
  normalizeEffort,
  EFFORT_LEVELS,
  SUPPORTED,
};
