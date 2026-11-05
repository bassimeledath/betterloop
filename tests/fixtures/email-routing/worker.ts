// Local-only provider fixture. Never deploy this worker or use a real credential.
const addresses = new Map<
  string,
  { id: string; email: string; verified: string | null }
>();
export default {
  async fetch(request: Request) {
    const url = new URL(request.url);
    if (
      url.pathname === "/__verify" &&
      request.method === "POST" &&
      ["127.0.0.1", "localhost"].includes(url.hostname)
    ) {
      const { email } = (await request.json()) as { email: string };
      const row = addresses.get(email);
      if (!row) return new Response("Not found", { status: 404 });
      row.verified = new Date().toISOString();
      return Response.json({ ok: true });
    }
    if (
      request.headers.get("Authorization") !== "Bearer local-email-enrollment"
    )
      return new Response("Not found", { status: 404 });
    const match = url.pathname.match(/\/addresses\/([^/]+)$/);
    if (request.method === "GET" && match) {
      const row = [...addresses.values()].find((a) => a.id === match[1]);
      return Response.json(
        { success: !!row, result: row },
        { status: row ? 200 : 404 },
      );
    }
    if (request.method === "GET")
      return Response.json({
        success: true,
        result: [...addresses.values()],
        result_info: { total_pages: 1 },
      });
    const { email } = (await request.json()) as { email: string };
    if (addresses.has(email))
      return Response.json({ success: false }, { status: 409 });
    const row = {
      id: crypto.randomUUID().replaceAll("-", ""),
      email,
      verified: null,
    };
    addresses.set(email, row);
    return Response.json({ success: true, result: row });
  },
};
