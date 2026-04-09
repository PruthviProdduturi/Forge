// Empty string → relative paths (/api/...) served via the same-origin ingress.
// Override NEXT_PUBLIC_API_BASE_URL only when running outside the cluster.
export const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";
