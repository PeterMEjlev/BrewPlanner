/** Normalize a thrown value into a user-facing message. */
export function asMessage(e: unknown): string {
  return e instanceof Error ? e.message : 'Something went wrong';
}
