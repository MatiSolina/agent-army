/**
 * Discover the WhatsApp phone numbers in a Kapso project from its Platform API
 * key, so the channel form can offer a picker instead of asking the operator to
 * paste a raw `phone_number_id`. A project API key is scoped to one project and
 * lists all of that project's numbers (GET /platform/v1/phone-numbers); there is
 * no cross-project listing without the personal CLI session, which Kapso does
 * not expose as a public OAuth flow.
 *
 * `phoneNumberId` is the Meta phone number id (`phone_number_id`) that the
 * generated channel uses to send replies via
 * `https://api.kapso.ai/meta/whatsapp/v23.0/{phoneNumberId}/messages`, i.e. the
 * exact value that belongs in KAPSO_PHONE_NUMBER_ID.
 */
export type KapsoPhoneNumber = {
  phoneNumberId: string
  /** Human display phone number (e.g. "+1 205-840-7113"); null if Kapso has none. */
  phoneNumber: string | null
  label: string
  status: string | null
}

const PHONE_NUMBERS_URL =
  "https://api.kapso.ai/platform/v1/whatsapp/phone_numbers"

type RawPhoneNumber = {
  phone_number_id?: unknown
  display_phone_number?: unknown
  verified_name?: unknown
  display_name?: unknown
  status?: unknown
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function labelFor(e: RawPhoneNumber, phoneNumberId: string): string {
  const phone = str(e.display_phone_number)
  const name = str(e.verified_name) ?? str(e.display_name)
  return [phone, name].filter(Boolean).join(" · ") || phoneNumberId
}

export async function listKapsoPhoneNumbers(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<KapsoPhoneNumber[]> {
  const key = apiKey.trim()
  if (!key) throw new Error("A Kapso API key is required")

  const res = await fetchImpl(PHONE_NUMBERS_URL, {
    headers: { "X-API-Key": key, Accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) {
    throw new Error(`Kapso phone-numbers request failed (${res.status})`)
  }

  const body = (await res.json()) as { data?: RawPhoneNumber[] }
  const rows = Array.isArray(body.data) ? body.data : []
  return rows
    .map((e) => {
      const phoneNumberId = str(e.phone_number_id)
      if (!phoneNumberId) return null
      return {
        phoneNumberId,
        phoneNumber: str(e.display_phone_number),
        label: labelFor(e, phoneNumberId),
        status: str(e.status),
      }
    })
    .filter((n): n is KapsoPhoneNumber => n !== null)
}

/** The inbound event the generated Kapso channel parses (whatsapp.message.received). */
const KAPSO_WEBHOOK_EVENTS = ["whatsapp.message.received"]

/**
 * Register (or refresh) the deployed agent's Kapso webhook so inbound WhatsApp
 * messages reach `<deployment>/kapso/webhook`, with no manual URL paste and no
 * operator-provided signing secret. Kapso's create-webhook endpoint accepts a
 * client-supplied `secret_key`, so the control plane mints the secret, bakes it
 * into the agent (KAPSO_WEBHOOK_SECRET) AND registers it here on promote, exactly
 * like Telegram setWebhook / Discord interactions-endpoint.
 *
 * Idempotent: a webhook already pointing at `url` is PATCHed (secret rotated) so
 * re-running every promote never creates duplicate endpoints (which would double
 * every inbound delivery).
 *
 * SECURITY: the API key and signing secret are NEVER included in a thrown error.
 */
export async function registerKapsoWebhook(args: {
  apiKey: string
  phoneNumberId: string
  url: string
  secret: string
  fetchImpl?: typeof fetch
}): Promise<void> {
  const { apiKey, phoneNumberId, url, secret, fetchImpl = fetch } = args
  const key = apiKey.trim()
  if (!key) throw new Error("A Kapso API key is required")
  const base = `https://api.kapso.ai/platform/v1/whatsapp/phone_numbers/${encodeURIComponent(
    phoneNumberId,
  )}/webhooks`
  const headers = {
    "X-API-Key": key,
    "Content-Type": "application/json",
    Accept: "application/json",
  }

  const listRes = await fetchImpl(base, {
    headers,
    signal: AbortSignal.timeout(20_000),
  })
  if (!listRes.ok) {
    throw new Error(`Kapso list webhooks failed (${listRes.status})`)
  }
  const listBody = (await listRes.json()) as {
    data?: { id?: unknown; url?: unknown }[]
  }
  const existing = (Array.isArray(listBody.data) ? listBody.data : []).find(
    (w) => typeof w.url === "string" && w.url === url,
  )
  const existingId =
    existing && typeof existing.id === "string" ? existing.id : null

  const webhook = existingId
    ? { secret_key: secret, events: KAPSO_WEBHOOK_EVENTS, active: true }
    : { url, secret_key: secret, events: KAPSO_WEBHOOK_EVENTS, active: true }
  const res = await fetchImpl(existingId ? `${base}/${existingId}` : base, {
    method: existingId ? "PATCH" : "POST",
    headers,
    body: JSON.stringify({ whatsapp_webhook: webhook }),
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) {
    // NEVER include apiKey or secret in the message.
    throw new Error(
      `Kapso ${existingId ? "update" : "create"} webhook failed (${res.status})`,
    )
  }
}
