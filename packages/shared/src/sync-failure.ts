export interface ConversationCaptureFailure {
  source_id: string;
  updated_at: string | null;
  attempts: number;
  quarantined: boolean;
  retry_after?: string;
}
export const MAX_CAPTURE_ATTEMPTS = 3;

/** Observed 5xx identities are remembered independently of counted attempts. */
export interface DetailFailureIdentity {
  source_id: string;
  updated_at: string | null;
  /** Another detail request worked in a completed run containing this failure. */
  confirmed_local?: boolean;
}
