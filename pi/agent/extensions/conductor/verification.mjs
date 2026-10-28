// Normalize the caller's verification plan; Conductor owns command execution.
export function verificationChecks(args) {
  function command(value, label) {
    if (!Array.isArray(value) || value.length < 1 || value.length > 64 ||
        value.some(part => typeof part !== 'string' || !part || part.includes('\0') || part.length > 8192) ||
        !value[0].trim()) {
      throw new Error(label + ' must be a nonempty executable-and-arguments array');
    }
    return [...value];
  }
  if (args.checks !== undefined) {
    if (args.buildCommand !== undefined || args.testCommand !== undefined) {
      throw new Error('Supply checks or buildCommand/testCommand, not both');
    }
    if (!Array.isArray(args.checks) || args.checks.length < 1 || args.checks.length > 64) {
      throw new Error('checks must contain between 1 and 64 named verification commands');
    }
    const names = new Set();
    return args.checks.map(check => {
      if (!check || typeof check !== 'object' || Array.isArray(check) ||
          Object.keys(check).some(key => !['name', 'command'].includes(key)) ||
          typeof check.name !== 'string' || !check.name.trim() || check.name.length > 256 ||
          check.name.includes('\0') || check.name !== check.name.trim() || names.has(check.name)) {
        throw new Error('Each check requires a unique nonblank name and a command (no other fields)');
      }
      names.add(check.name);
      return { name: check.name, command: command(check.command, 'checks.' + check.name + '.command') };
    });
  }
  return [
    { name: 'build', command: command(args.buildCommand, 'buildCommand') },
    { name: 'test', command: command(args.testCommand, 'testCommand') },
  ];
}

export function sameVerification(left, right) {
  return JSON.stringify(verificationChecks(left)) === JSON.stringify(verificationChecks(right));
}
