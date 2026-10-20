import { defineFunction } from "@aws-amplify/backend";
export const mediaMaintenance = defineFunction({
  name: "media-maintenance",
  entry: "./handler.ts",
  resourceGroupName: "data",
  timeoutSeconds: 300,
  memoryMB: 512,
  schedule: "every day",
  logging: { format: "json", retention: "3 months" },
});
