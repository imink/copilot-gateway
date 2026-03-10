let _getEnv: (name: string) => string = () => "";

export function initEnv(fn: (name: string) => string): void {
  _getEnv = fn;
}

export function getEnv(name: string): string {
  return _getEnv(name);
}
