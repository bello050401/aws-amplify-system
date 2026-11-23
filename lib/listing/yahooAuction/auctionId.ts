/** Observed Yahoo IDs: legacy letter prefix or exactly ten decimal digits. */
export const yahooAuctionIdValid = (id: unknown): id is string => typeof id === "string" && id===id.trim() && /^(?:[a-z][0-9]{8,12}|[0-9]{10})$/.test(id);
