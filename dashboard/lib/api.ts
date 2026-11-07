// Typed client for the switchyard-server management API.
// Session cookie flows via credentials:include; the server owns auth state.

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const OFFLINE_MESSAGE = "Unable to reach Switchyard. Check your connection and try again.";

/** Human message for a failed response. The server's own text is kept for
 *  4xx validation errors (it names the field); everything else is mapped. */
function messageFor(status: number, body: unknown): string {
  const server =
    body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string"
      ? ((body as { error: string }).error.trim() || null)
      : null;
  if (status === 403) return "You don't have permission to do this.";
  if (status === 409) return "Someone else changed this. Reload to see the latest version.";
  if (status >= 500) return OFFLINE_MESSAGE;
  return server ?? "That request wasn't accepted. Check the values and try again.";
}

/** fetch that turns network failures (offline, DNS, CORS, server down) into
 *  an ApiError with a human message instead of "Failed to fetch". */
async function send(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch {
    throw new ApiError(0, OFFLINE_MESSAGE);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await send(`${API_URL}${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    // 422 carries structured details the editor parses; keep its raw body.
    if (res.status === 422 && body && typeof body === "object" && "errors" in body) {
      throw new ApiError(res.status, JSON.stringify(body));
    }
    throw new ApiError(res.status, messageFor(res.status, body));
  }
  return body as T;
}

export const apiGet = <T,>(path: string) => request<T>(path);
export const apiPost = <T,>(path: string, body: unknown) =>
  request<T>(path, { method: "POST", body: JSON.stringify(body) });
export const apiPut = <T,>(path: string, body: unknown) =>
  request<T>(path, { method: "PUT", body: JSON.stringify(body) });
export const apiPatch = <T,>(path: string, body: unknown) =>
  request<T>(path, { method: "PATCH", body: JSON.stringify(body) });
export const apiDelete = (path: string) =>
  request<void>(path, { method: "DELETE" });

/** GET returning { data, total } via the X-Total-Count header (audit list). */
export async function apiGetPaged<T>(path: string): Promise<{ data: T; total: number }> {
  const res = await send(`${API_URL}${path}`, { credentials: "include" });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(res.status, messageFor(res.status, body));
  }
  return { data: body as T, total: Number(res.headers.get("x-total-count") ?? 0) };
}

// --- Shapes (mirror the server's JSON) ---

export interface Me {
  id: string;
  email: string;
}

export interface Project {
  id: string;
  key: string;
  name: string;
  created_at: string;
}

export interface Env {
  id: string;
  key: string;
  name: string;
  protected: boolean;
  version: number;
}

export type FlagKind = "bool" | "string";

export interface Flag {
  key: string;
  type: FlagKind;
  description: string;
  archived: boolean;
  created_at: string;
}

export interface FlagConfig {
  revision: number;
  enabled: boolean;
  offValue: boolean | string;
  rules: unknown[];
  fallthrough: unknown;
  updated_at: string;
  updated_by: string | null;
}

export interface Member {
  id: string;
  email: string;
  role: "admin" | "editor" | "viewer";
}

export interface SdkKey {
  id: string;
  name: string;
  /** First characters of the key, for display. Never the secret. */
  prefix: string;
  created_at: string;
  revoked_at: string | null;
  created_by: string | null;
  last_used_at: string | null;
}

export interface SdkKeyCreated {
  id: string;
  name: string;
  prefix: string;
  created_at: string;
  revoked_at: string | null;
  created_by: string | null;
  last_used_at: string | null;
  /** The full secret. Returned exactly once, at creation. */
  key: string;
}
