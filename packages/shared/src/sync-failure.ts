export interface ConversationCaptureFailure {
  source_id: string;
  updated_at: string | null;
  attempts: number;
  quarantined: boolean;
  retry_after?: string;
}
export const MAX_CAPTURE_ATTEMPTS = 3;
