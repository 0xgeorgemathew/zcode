'use strict';
// lib/commands/run.js — one-shot turn (DESIGN §9, §10). Built up across TDD
// steps; key resolution (step 2) precedes any engine work.
const { resolveKey, NoKeyError } = require('../key.js');

module.exports = async function run(parsed) {
  let key;
  try {
    key = resolveKey(process.env);
  } catch (err) {
    if (err instanceof NoKeyError) {
      process.stderr.write(`zai-code: ${err.message}\n`);
      process.exit(3);
    }
    throw err;
  }
  process.stderr.write('zai-code: run not implemented yet\n');
  process.exit(1);
};
