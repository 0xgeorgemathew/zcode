'use strict';
// Task contract from its sources: a base object (JSON contract / markdown
// brief) plus CLI-style additions. Wraps normalizeContract with what needs
// the filesystem: inlining "@file" entries, dropping a --file that is also
// inlined as context, and validating unit ownership against the session's.
// Shared by `zcode task` and anything else that builds contracts (plan files).
//
// Throws ContractError for every problem, before any engine spawn.
const fs = require('node:fs');
const path = require('node:path');
const { normalizeContract, ContractError } = require('./contract.js');
const { workspaceRoot, normalizeOwns, isOwned, ownsOverlap, OwnershipError } = require('./workspace.js');

const FILE_REF = /^@(\S+)$/;

const canon = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
};

const toArray = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);

// Units must stay inside the session's owns and must not overlap each other.
function validateUnits(contract, cwd) {
  const units = contract.units || [];
  if (!units.length) return;
  let root;
  const norm = (patterns, flag) => {
    root = root || workspaceRoot(cwd);
    try {
      return normalizeOwns(patterns, cwd, root, flag);
    } catch (err) {
      if (err instanceof OwnershipError) throw new ContractError(err.message);
      throw err;
    }
  };
  const sessionOwns = norm(contract.owns || [], '--owns');
  const owned = units
    .filter((u) => u.owns && u.owns.length)
    .map((u) => ({ unit: u, patterns: norm(u.owns, `unit "${u.name}" owns`) }));
  for (const { unit, patterns } of owned) {
    const at = patterns.findIndex((p) => !isOwned(p, sessionOwns));
    if (at >= 0) {
      throw new ContractError(
        `unit "${unit.name}" owns "${unit.owns[at]}", which is outside the session's owns (${(contract.owns || []).join(', ') || 'whole workspace'})`
      );
    }
  }
  for (let i = 0; i < owned.length; i++) {
    for (let j = i + 1; j < owned.length; j++) {
      if (ownsOverlap(owned[i].patterns, owned[j].patterns)) {
        throw new ContractError(
          `units "${owned[i].unit.name}" and "${owned[j].unit.name}" have overlapping owns (${owned[i].unit.owns.join(', ')} / ${owned[j].unit.owns.join(', ')}); units must be disjoint`
        );
      }
    }
  }
}

// base: parsed contract object; baseDir: where its "@file" entries resolve
// (the contract file's directory, else cwd), then `cwd` when not found there. additions: the CLI flags
// (strings; "@file" resolves against the process cwd). cwd: --cwd.
function buildContract({ base = {}, baseDir = process.cwd(), objective = '', additions = {}, cwd = process.cwd() }) {
  const inlined = new Set();
  // dirs are tried in order; the error names every path tried.
  const inline = (list, dirs, label) =>
    toArray(list).map((item) => {
      const text = String(item).trim();
      const m = FILE_REF.exec(text);
      if (!m) return text;
      const tried = [];
      for (const dir of dirs) {
        const file = path.resolve(dir, m[1]);
        if (tried.includes(file)) continue;
        tried.push(file);
        try {
          const body = fs.readFileSync(file, 'utf8');
          inlined.add(canon(file));
          return body;
        } catch {
          /* try the next directory */
        }
      }
      throw new ContractError(`${label} file "${m[1]}" could not be read (tried ${tried.join(', ')}).`);
    });

  let b = base;
  if (b && typeof b === 'object' && !Array.isArray(b)) {
    b = { ...b };
    for (const key of ['context', 'decisions']) {
      if (b[key] !== undefined) b[key] = inline(b[key], [baseDir, cwd], `contract ${key}`);
    }
  }
  const flagDir = process.cwd();
  const contract = normalizeContract(b, {
    ...additions,
    objective,
    context: inline(additions.context, [flagDir], '--context'),
    decisions: inline(additions.decisions, [flagDir], '--decisions'),
  });
  // A file the executor already gets inlined is not also listed to read.
  if (inlined.size) {
    contract.files = contract.files.filter(
      (f) => ![cwd, baseDir, flagDir].some((dir) => inlined.has(canon(path.resolve(dir, f))))
    );
  }
  validateUnits(contract, cwd);
  return contract;
}

module.exports = { buildContract, validateUnits };
