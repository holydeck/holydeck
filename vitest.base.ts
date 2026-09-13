// One place for the coverage floor every workspace runs under. A package is free to add its own
// includes, excludes and timeouts, but not its own thresholds: lowering the floor anywhere means
// editing this file, which every package imports, instead of quietly changing a number in one config.
export const coverage100 = {
  statements: 100,
  branches: 100,
  functions: 100,
  lines: 100,
};
