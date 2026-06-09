const LINE_CONTENT_BASE_URL = "https://api-data.line.me/v2/bot/message";

export interface LineMessageContent {
  bytes: Uint8Array;
  mimeType: string | null;
}

export async function downloadLineMessageContent(
  messageId: string,
  accessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN,
): Promise<LineMessageContent> {
  if (!accessToken) {
    throw new Error("LINE_CHANNEL_ACCESS_TOKEN is not configured");
  }

  const response = await fetch(
    `${LINE_CONTENT_BASE_URL}/${encodeURIComponent(messageId)}/content`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  );

  if (!response.ok) {
    throw new Error(`LINE content download failed with HTTP ${response.status}`);
  }

  const mimeType = response.headers.get("content-type")?.split(";")[0]?.trim() || null;
  const bytes = new Uint8Array(await response.arrayBuffer());

  if (bytes.byteLength === 0) {
    throw new Error("LINE content download returned an empty body");
  }

  return { bytes, mimeType };
}
