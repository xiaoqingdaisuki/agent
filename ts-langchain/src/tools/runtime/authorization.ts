import type { ToolCallContext, ToolDescriptor } from "../contracts.js";

const ROLE_PERMISSIONS: Record<string, readonly string[]> = {
  viewer: ["weather.read", "web.search", "web.read", "web.extract", "knowledge.search", "file.search", "memory.session.read", "memory.user.read"],
  member: ["weather.read", "web.search", "web.read", "web.extract", "knowledge.search", "file.search", "memory.session.read", "memory.user.read"],
  admin: ["*"],
};

// 根据服务端角色计算允许的工具权限集合。
export function permissionsForRoles(roles: readonly string[] = ["member"]): ReadonlySet<string> {
  return new Set(roles.flatMap((role) => ROLE_PERMISSIONS[role] ?? []));
}

// 判断可信上下文是否满足工具声明的全部权限。
export function hasToolPermissions(context: ToolCallContext, descriptor: ToolDescriptor): boolean {
  if (descriptor.risk_level === "R0") return true;
  const required = descriptor.required_permissions ?? [];
  if (required.length === 0) return false;
  const granted = permissionsForRoles(context.roles);
  return granted.has("*") || required.every((permission) => granted.has(permission));
}

// 返回安全默认角色，避免未声明身份时获得写权限。
export function defaultToolRoles(): string[] {
  return ["member"];
}
