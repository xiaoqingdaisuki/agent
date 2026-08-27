"""工具角色和权限策略。"""

from src.tools.contracts import ToolCallContext, ToolDescriptor

ROLE_PERMISSIONS: dict[str, frozenset[str]] = {
    "viewer": frozenset({"weather.read", "web.search", "web.read", "web.extract", "knowledge.search", "file.search", "memory.session.read", "memory.user.read"}),
    "member": frozenset({"weather.read", "web.search", "web.read", "web.extract", "knowledge.search", "file.search", "memory.session.read", "memory.user.read"}),
    "admin": frozenset({"*"}),
}


# 根据服务端角色计算允许的工具权限集合。
def permissions_for_roles(roles: list[str] | None = None) -> frozenset[str]:
    resolved_roles = roles or ["member"]
    return frozenset(permission for role in resolved_roles for permission in ROLE_PERMISSIONS.get(role, frozenset()))


# 判断可信上下文是否满足工具声明的全部权限。
def has_tool_permissions(context: ToolCallContext, descriptor: ToolDescriptor) -> bool:
    if descriptor.risk_level == "R0":
        return True
    required = descriptor.required_permissions or []
    if not required:
        return False
    granted = permissions_for_roles(context.roles)
    return "*" in granted or all(permission in granted for permission in required)


# 返回安全默认角色，避免未声明身份时获得写权限。
def default_tool_roles() -> list[str]:
    return ["member"]
