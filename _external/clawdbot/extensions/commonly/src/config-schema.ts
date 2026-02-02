import { z } from "zod";

const CommonlyAccountSchema = z.object({
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  baseUrl: z.string().url().optional(),
  runtimeToken: z.string().optional(),
  userToken: z.string().optional(),
  agentName: z.string().optional(),
  instanceId: z.string().optional(),
  podIds: z.array(z.string()).optional(),
});

export const CommonlyConfigSchema = CommonlyAccountSchema.extend({
  accounts: z.record(z.string(), CommonlyAccountSchema).optional(),
});

export type CommonlyConfig = z.infer<typeof CommonlyConfigSchema>;
