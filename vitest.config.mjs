import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Worktrees de outras sessões ficam em .claude/worktrees com cópias dos
    // testes (e de outro código): o npm test deste checkout não as roda.
    exclude: [...configDefaults.exclude, '.claude/**'],
  },
});
