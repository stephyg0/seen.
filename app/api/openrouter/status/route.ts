import { DEFAULT_MODEL } from "@/lib/emotion-engine";

export const runtime = "nodejs";

export function GET() {
  return Response.json({
    configured: Boolean(process.env.OPENROUTER_API_KEY),
    model: DEFAULT_MODEL
  });
}
