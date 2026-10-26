/** 按 Worker 运行环境为内存缓存应用条目数和内容权重预算 */

// 用条目数和内容权重限制 Worker 缓存，Node 服务保留原来的进程内行为
export function createRuntimeCache<K, V>(
  maxEntries = 128,
  maxWeight = 4_000_000,
  // 默认将每个缓存项视为一个权重单位
  weight: (value: V) => number = () => 1,
): Map<K, V> {
  if (process.env.AGENT_RUNTIME !== "workers") return new Map<K, V>();
  return new BudgetMap(maxEntries, maxWeight, weight);
}

class BudgetMap<K, V> extends Map<K, V> {
  private weights = new Map<K, number>();
  private totalWeight = 0;

  // 保存缓存预算和权重估算函数
  constructor(
    private readonly maxEntries: number,
    private readonly maxWeight: number,
    private readonly weight: (value: V) => number,
  ) { super(); }

  // 更新条目后按最早写入顺序淘汰，超大条目直接回源而不占用长期内存
  override set(key: K, value: V): this {
    this.delete(key);
    const cost = Math.max(1, this.weight(value));
    if (cost > this.maxWeight) return this;
    super.set(key, value);
    this.weights.set(key, cost);
    this.totalWeight += cost;
    while (this.size > this.maxEntries || this.totalWeight > this.maxWeight) {
      this.delete(this.keys().next().value!);
    }
    return this;
  }

  // 删除缓存时同步释放对应权重
  override delete(key: K): boolean {
    this.totalWeight -= this.weights.get(key) ?? 0;
    this.weights.delete(key);
    return super.delete(key);
  }

  // 清空全部条目与预算统计
  override clear(): void {
    super.clear();
    this.weights.clear();
    this.totalWeight = 0;
  }
}
