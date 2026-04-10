const origLog = console.log;
const origError = console.error;

function ts(): string {
  return "[" + new Date().toISOString() + "]";
}

console.log = (...args: unknown[]) => {
  if (typeof args[0] === "string" && args[0].startsWith("[")) {
    // Already has a tag like [INTAKE], prepend timestamp
    origLog(ts(), ...args);
  } else {
    origLog(ts(), ...args);
  }
};

console.error = (...args: unknown[]) => {
  origError(ts(), ...args);
};

export {};
