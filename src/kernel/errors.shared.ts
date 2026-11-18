/** What a caught value says: an Error's message, or the value as text. */
export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
