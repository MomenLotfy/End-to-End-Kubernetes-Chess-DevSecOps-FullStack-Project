import { getProfile } from "./client";

const response = (status, body = {}) => ({
  status,
  ok: status >= 200 && status < 300,
  json: jest.fn().mockResolvedValue(body),
});

test("sends API requests with cookie credentials", async () => {
  global.fetch = jest.fn().mockResolvedValue(response(200, { id: 7 }));

  await expect(getProfile()).resolves.toEqual({ id: 7 });

  expect(global.fetch).toHaveBeenCalledWith("/api/auth/profile", expect.objectContaining({
    method: "GET",
    credentials: "include",
  }));
  expect(global.fetch.mock.calls[0][1].headers.Authorization).toBeUndefined();
});

test("rotates the session once and retries the original request after a 401", async () => {
  global.fetch = jest.fn()
    .mockResolvedValueOnce(response(401, { error: "Authentication required" }))
    .mockResolvedValueOnce(response(200))
    .mockResolvedValueOnce(response(200, { id: 7, username: "restored-user" }));

  await expect(getProfile()).resolves.toMatchObject({ id: 7 });

  expect(global.fetch).toHaveBeenCalledTimes(3);
  expect(global.fetch.mock.calls[1]).toEqual([
    "/api/auth/refresh",
    { method: "POST", credentials: "include" },
  ]);
  expect(global.fetch.mock.calls[2][0]).toBe("/api/auth/profile");
  expect(global.fetch.mock.calls[2][1]).toEqual(expect.objectContaining({ credentials: "include" }));
});

test("does not loop when refresh is rejected", async () => {
  global.fetch = jest.fn()
    .mockResolvedValueOnce(response(401, { error: "Authentication required" }))
    .mockResolvedValueOnce(response(401, { error: "Authentication required" }));

  await expect(getProfile()).rejects.toThrow("Authentication required");
  expect(global.fetch).toHaveBeenCalledTimes(2);
});
