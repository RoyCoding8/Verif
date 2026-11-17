// Typed backend errors so HTTP handlers can map failure kinds to statuses
// without string sniffing. Messages are built for display and must never
// contain credential material.

export class ValidationError extends Error {}
export class OperationalError extends Error {}
