import { isAxiosError } from 'axios';

export const MAX_PROMPT_LENGTH = 20_000;
export const MAX_LYRIC_LENGTH = 100_000;

export interface LyricsPrompt {
  text: string;
  default_text: string;
  revision: number;
  updated_at: string;
}

export function promptErrorMessage(error: unknown, fallback: string): string {
  if (isAxiosError(error) && typeof error.response?.data?.detail === 'string') {
    return error.response.data.detail;
  }
  return fallback;
}
