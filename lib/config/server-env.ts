import "server-only";
import { parseServerEnv } from "@/lib/config/server-env-schema";

export function getServerEnv() {
  return parseServerEnv(process.env);
}
