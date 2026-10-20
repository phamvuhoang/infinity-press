// Supabase Auth accepts unknown addresses silently but rate-limits known ones, so both
// must look the same to avoid revealing which accounts exist.
const undisclosedErrorCodes = new Set(["user_not_found", "over_email_send_rate_limit"]);

export function getPasswordRecoveryOutcome(error: { code?: string } | null) {
  if (!error || (error.code && undisclosedErrorCodes.has(error.code))) return "sent";
  return "failed";
}
