/**
 * Profile Routes — 用户画像
 *
 * PUT   /internal/v1/users/{user_id}/profile  — 创建/更新画像
 * GET   /internal/v1/users/{user_id}/profile  — 获取画像
 */

import { getOrCreateProfile, getProfile, updateProfile } from "../repositories/profile.js";
import { ProfileSaveSchema, GatewayResponseSchema } from "../schemas/memory-models.js";

// 创建或注册 registerProfileRoutes 所需的数据
export function registerProfileRoutes(app: any) {
  // 创建/更新画像
  app.put("/internal/v1/users/:user_id/profile", async (c: any) => {
    const userId = c.req.param("user_id");
    const body = await c.req.json();
    const parsed = ProfileSaveSchema.parse(body);
    const preferencesJson = JSON.stringify(parsed.preferences);

    const profile = await getOrCreateProfile(c.env.DB, userId, parsed.name);
    const updated = await updateProfile(c.env.DB, userId, {
      name: parsed.name,
      preferences_json: preferencesJson,
    });

    const response = {
      ok: true,
      data: updated ?? profile,
      error: null,
      meta: { request_id: c.get("requestId") },
    };
    return c.json(response);
  });

  // 获取画像
  app.get("/internal/v1/users/:user_id/profile", async (c: any) => {
    const userId = c.req.param("user_id");
    const profile = await getProfile(c.env.DB, userId);

    if (!profile) {
      return c.json(
        {
          ok: false,
          data: null,
          error: { code: "MEMORY_USER_NOT_FOUND", message: "用户不存在" },
          meta: { request_id: c.get("requestId") },
        },
        404,
      );
    }

    return c.json({
      ok: true,
      data: profile,
      error: null,
      meta: { request_id: c.get("requestId") },
    });
  });
}
