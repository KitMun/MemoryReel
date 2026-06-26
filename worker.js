export default {
  async fetch(request, env, ctx) {
    return new Response(
      JSON.stringify({
        status: "ok",
        message: "MemoryReel Worker is running",
      }),
      {
        headers: { "Content-Type": "application/json" },
      }
    );
  },
};
