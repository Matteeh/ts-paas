import { defineConfig } from "@matteeh/osq";

export default defineConfig({
  harness: "pi",
  pi: { provider: "deepseek", model: "deepseek-flash", thinking: "high" },
  queue: { maxPlanningSessions: 20, maxPlanningCost: 25 },
  maxConcurrency: 1,
});
