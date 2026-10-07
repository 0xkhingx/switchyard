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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const message =
      (body && (body.error as string)) || `Request failed (${res.status})`;
    throw new ApiError(res.status, message);
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
  const res = await fetch(`${API_URL}${path}`, { credentials: "include" });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(res.status, (body && body.error) || `Request failed (${res.status})`);
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
