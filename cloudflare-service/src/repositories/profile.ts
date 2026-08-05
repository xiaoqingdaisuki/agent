/**
 * ProfileRepository — 用户画像仓储
 *
 * 直接操作 D1，提供用户画像的 CRUD 操作
 */

// 用户画像数据类型
export interface UserProfile {
  user_id: string;
  name: string;
  preferences_json: string;
  created_at: string;
  updated_at: string;
}

// 创建用户画像
export async function createProfile(db: D1Database, profile: Omit<UserProfile, "created_at" | "updated_at">): Promise<UserProfile> {
  const now = new Date().toISOString();
  await db
    .prepare("INSERT INTO profiles (user_id, name, preferences_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .bind(profile.user_id, profile.name, profile.preferences_json || "{}", now, now)
    .run();

  return {
    ...profile,
    preferences_json: profile.preferences_json || "{}",
    created_at: now,
    updated_at: now,
  };
}

// 获取用户画像
export async function getProfile(db: D1Database, userId: string): Promise<UserProfile | null> {
  const result = await db
    .prepare("SELECT user_id, name, preferences_json, created_at, updated_at FROM profiles WHERE user_id = ?")
    .bind(userId)
    .first<UserProfile>();

  return result ?? null;
}

// 创建或获取用户画像
export async function getOrCreateProfile(db: D1Database, userId: string, name: string = ""): Promise<UserProfile> {
  const existing = await getProfile(db, userId);
  if (existing) {
    // 更新 last_active_at 等价字段
    const now = new Date().toISOString();
    await db
      .prepare("UPDATE profiles SET updated_at = ? WHERE user_id = ?")
      .bind(now, userId)
      .run();
    return { ...existing, updated_at: now };
  }

  return createProfile(db, { user_id: userId, name, preferences_json: "{}" });
}

// 更新用户画像
export async function updateProfile(db: D1Database, userId: string, changes: Partial<Pick<UserProfile, "name" | "preferences_json">>): Promise<UserProfile | null> {
  const existing = await getProfile(db, userId);
  if (!existing) return null;

  const newName = changes.name !== undefined ? changes.name : existing.name;
  const newPrefs = changes.preferences_json !== undefined ? changes.preferences_json : existing.preferences_json;
  const now = new Date().toISOString();

  await db
    .prepare("UPDATE profiles SET name = ?, preferences_json = ?, updated_at = ? WHERE user_id = ?")
    .bind(newName, newPrefs, now, userId)
    .run();

  return { ...existing, name: newName, preferences_json: newPrefs, updated_at: now };
}
