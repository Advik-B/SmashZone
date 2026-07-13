export function baseUrl(): string {
  const url = process.env.E2E_BASE_URL;
  if (!url) throw new Error("E2E_BASE_URL not set");
  return url.replace(/\/$/, "");
}

export function api(path: string, init?: RequestInit): Promise<Response> {
  return fetch(baseUrl() + path, init);
}

/** POST /api/rooms → the room code (also the readiness probe the server docs use). */
export async function createRoomCode(): Promise<string> {
  const res = await api("/api/rooms", { method: "POST" });
  if (!res.ok) throw new Error(`create room failed: ${res.status}`);
  const body = (await res.json()) as { code: string };
  return body.code;
}
