import { describe, it, expect } from "vitest";

// ============ Profile Service Tests ============

describe("ProfileService", () => {
  it("should create profile with defaults", () => {
    // Simulate getOrCreate
    const profiles = new Map<string, any>();
    const create = (id: string, name = "") => {
      if (!profiles.has(id)) {
        profiles.set(id, { id, name, preferences: {}, created_at: new Date().toISOString(), last_active_at: new Date().toISOString() });
      }
      return profiles.get(id)!;
    };

    const profile = create("user_1", "Alice");
    expect(profile.id).toBe("user_1");
    expect(profile.name).toBe("Alice");
    expect(profile.preferences).toEqual({});
  });

  it("should not overwrite existing profile", () => {
    const profiles = new Map<string, any>();
    const create = (id: string, name = "") => {
      if (!profiles.has(id)) {
        profiles.set(id, { id, name, preferences: {}, created_at: new Date().toISOString(), last_active_at: new Date().toISOString() });
      }
      return profiles.get(id)!;
    };

    create("user_2", "Bob");
    const profile = create("user_2", "Charlie");
    expect(profile.name).toBe("Bob");
  });
});

// ============ Memory Service Tests ============

describe("MemoryService", () => {
  const memories: any[] = [];

  const addMemory = (userId: string, content: string, category = "fact", importance = 3) => {
    memories.push({
      id: `mem_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
      user_id: userId,
      content,
      category,
      importance,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    return memories[memories.length - 1];
  };

  const getMemories = (userId: string) =>
    memories
      .filter((m) => m.user_id === userId)
      .sort((a, b) => b.importance - a.importance);

  it("should add memory", () => {
    const mem = addMemory("user_3", "用户喜欢简洁", "preference", 4);
    expect(mem.content).toBe("用户喜欢简洁");
    expect(mem.category).toBe("preference");
  });

  it("should sort by importance", () => {
    addMemory("user_4", "低", "fact", 1);
    addMemory("user_4", "高", "fact", 5);
    addMemory("user_4", "中", "fact", 3);

    const sorted = getMemories("user_4");
    expect(sorted[0].importance).toBe(5);
    expect(sorted[1].importance).toBe(3);
    expect(sorted[2].importance).toBe(1);
  });

  it("should filter by category", () => {
    addMemory("user_5", "偏好A", "preference");
    addMemory("user_5", "事实B", "fact");

    const prefs = getMemories("user_5").filter((m) => m.category === "preference");
    expect(prefs.length).toBe(1);
    expect(prefs[0].content).toBe("偏好A");
  });

  it("should build memory context", () => {
    addMemory("user_6", "用户在北京");
    addMemory("user_6", "用户喜欢简洁");

    const userMemories = getMemories("user_6");
    const lines = ["[我记住的关于你的事]", ...userMemories.map((m) => `- ${m.content}`), ""];
    const context = lines.join("\n");

    expect(context).toContain("用户在北京");
    expect(context).toContain("用户喜欢简洁");
    expect(context).toContain("[我记住的关于你的事]");
  });
});

// ============ Memory Extraction Tests ============

describe("Memory extraction rules", () => {
  const extractPreferences = (message: string) => {
    const results: string[] = [];
    const patterns = [
      /我喜欢(.+?)[。！\n]/,
      /我爱(.+?)[。！\n]/,
      /我讨厌(.+?)[。！\n]/,
      /别(.+?)[。！\n]/,
      /不要(.+?)[。！\n]/,
    ];
    for (const pattern of patterns) {
      const matches = message.matchAll(pattern);
      for (const match of matches) {
        results.push(match[1].trim());
      }
    }
    return results;
  };

  const extractInfo = (message: string) => {
    const results: string[] = [];
    const patterns = [
      /我在(.+?)[。！\n]/,
      /我叫(.+?)[。！\n]/,
      /我是(.+?)[。！\n]/,
    ];
    for (const pattern of patterns) {
      const matches = message.matchAll(pattern);
      for (const match of matches) {
        results.push(match[1].trim());
      }
    }
    return results;
  };

  it("should extract preference from '我喜欢'", () => {
    const results = extractPreferences("我喜欢简洁的回答");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]).toBe("简洁的回答");
  });

  it("should extract location from '我在'", () => {
    const results = extractInfo("我在北京");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]).toBe("北京");
  });

  it("should extract name from '我叫'", () => {
    const results = extractInfo("我叫小明");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]).toBe("小明");
  });

  it("should not extract from regular messages", () => {
    const prefs = extractPreferences("今天天气怎么样");
    const info = extractInfo("你好");
    expect(prefs.length).toBe(0);
    expect(info.length).toBe(0);
  });
});

// ============ History Service Tests ============

describe("HistoryService", () => {
  const records: any[] = [];

  const record = (userId: string, conversationId: string, question: string, answer: string) => {
    const rec = {
      id: `qa_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      user_id: userId,
      conversation_id: conversationId,
      question,
      answer,
      timestamp: new Date().toISOString(),
    };
    records.push(rec);
    return rec;
  };

  const getHistory = (userId: string, conversationId?: string, limit = 50) => {
    let result = records.filter((r) => r.user_id === userId);
    if (conversationId) {
      result = result.filter((r) => r.conversation_id === conversationId);
    }
    return result.slice(-limit);
  };

  it("should record Q&A", () => {
    const rec = record("user_7", "conv_1", "你好", "你好呀！");
    expect(rec.question).toBe("你好");
    expect(rec.answer).toBe("你好呀！");
  });

  it("should filter by conversation", () => {
    record("user_8", "conv_1", "Q1", "A1");
    record("user_8", "conv_1", "Q2", "A2");
    record("user_8", "conv_2", "Q3", "A3");

    expect(getHistory("user_8", "conv_1").length).toBe(2);
    expect(getHistory("user_8").length).toBe(3);
  });
});
