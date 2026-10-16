declare module "find-my-way/lib/handler-storage.js" {
  const HandlerStorage: { prototype: {
    constraints: string[];
    unconstrainedHandler: { constraints: Record<string, unknown> } | null;
    _compileCreateParamsObject(params: string[]): (values: string[]) => Record<string, string>;
    _compileGetHandlerMatchingConstraints(): void;
    _getHandlerMatchingConstraints(derived: Record<string, unknown>): { constraints: Record<string, unknown> } | null;
  } };
  export default HandlerStorage;
}
declare module "find-my-way/lib/node.js" {
  export const StaticNode: { prototype: {
    prefix: string;
    _compilePrefixMatch(): void;
    matchPrefix(path: string, index: number): boolean;
  } };
}
declare module "avvio/lib/debug.js" {
  const logger: { debug: (...args: unknown[]) => void };
  export default logger;
}
