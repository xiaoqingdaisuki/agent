/** 配置 Vitest 测试环境、初始化文件及测试执行选项 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/test_*.ts", "tests/**/*.test.ts"],
    setupFiles: ["./tests/vitest.setup.ts"],
    coverage: {
      reporter: ["text", "json"],
    },
  },
  // 使用 tsconfig.tests.json 对 tests/ 和 src/ 执行类型检查
  tsconfig: "./tsconfig.tests.json",
});
