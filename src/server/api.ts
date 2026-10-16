import type { REST, RouteLike } from "discord.js";

export interface Upload {
  name: string;
  data: Uint8Array;
}

// The slice of Discord's HTTP API the server tools use. The bot and the local command both hand in
// discord.js's REST client; tests hand in an in-memory guild.
export interface DiscordApi {
  get<T>(route: `/${string}`): Promise<T>;
  post<T>(route: `/${string}`, body: unknown, reason?: string, files?: Upload[]): Promise<T>;
  patch<T>(route: `/${string}`, body: unknown, reason?: string): Promise<T>;
  put(route: `/${string}`, body: unknown, reason?: string): Promise<void>;
  delete(route: `/${string}`, reason?: string): Promise<void>;
}

export function restApi(rest: REST): DiscordApi {
  const r = (route: string) => route as RouteLike;
  return {
    get: async <T>(route: `/${string}`) => (await rest.get(r(route))) as T,
    post: async <T>(route: `/${string}`, body: unknown, reason?: string, files?: Upload[]) =>
      (await rest.post(r(route), { body, reason, ...(files ? { files: files.map((f) => ({ name: f.name, data: Buffer.from(f.data) })) } : {}) })) as T,
    patch: async <T>(route: `/${string}`, body: unknown, reason?: string) =>
      (await rest.patch(r(route), { body, reason })) as T,
    put: async (route, body, reason) => {
      await rest.put(r(route), { body, reason });
    },
    delete: async (route, reason) => {
      await rest.delete(r(route), { reason });
    },
  };
}

// A Discord error status, from discord.js's DiscordAPIError or the test fake alike.
export const statusOf = (error: unknown): number | undefined =>
  typeof error === "object" && error !== null && typeof (error as { status?: unknown }).status === "number"
    ? (error as { status: number }).status
    : undefined;
